import { ToolsService } from '@deepseek-ai/dsh-tools';
import { createScope, scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope';
import { providerFromContext } from './providers.js';

/** Official ToolsService with registration-owned provider metadata and preset catalog reads. */
export default class ToolExposureRegistry extends ToolsService {
  registrations = new Map();
  catalogRevision = 0;
  presetCatalogs = new Map();

  /** Reconcile the policy before the host admits tools for the model step. */
  async resolve(context) {
    context.signal.throwIfAborted();
    this.ctx.emit('dsh-tool-exposure/before-tool-resolution', context.agent);
    return super.resolve(context);
  }

  /** Preserve official registration behavior and release its metadata with the same disposer. */
  register(definition, options = {}) {
    const ctx = this.ctx;
    const scope = scopeOf(ctx);
    const provider = providerFromContext(ctx, scope, definition.name);
    return ctx.effect(() => {
      const unregister = super.register(definition, options);
      let records = this.registrations.get(scope);
      if (records === undefined) this.registrations.set(scope, (records = new Map()));
      const record = { definition, provider };
      records.set(definition.name, record);
      this.catalogRevision += 1;
      this.presetCatalogs.clear();
      return () => {
        if (records.get(definition.name) === record) {
          records.delete(definition.name);
          if (records.size === 0) this.registrations.delete(scope);
          this.catalogRevision += 1;
          this.presetCatalogs.clear();
        }
        return unregister();
      };
    }, 'tool-exposure: tool registration');
  }

  /** Read inherited registrations before restrictions; an agent's own tools stay exempt. */
  toolCatalog(scope) {
    const records = new Map(this.registrations.get(undefined));
    if (scope !== undefined) {
      for (const ancestor of scopeChainOf(scope).slice(1).reverse()) {
        for (const [name, record] of this.registrations.get(ancestor) || []) records.set(name, record);
      }
    }
    return [...records].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, record]) => ({
      name,
      description: typeof record.definition.description === 'string' ? record.definition.description : '',
      provider: record.provider,
    }));
  }

  /** Read the exact preset revision inherited by a live agent. */
  agentToolCatalog(agent) {
    return this.toolCatalog(scopeOf(agent.ctx));
  }

  /** Preset rebinding can change this chain without a new tool registration. */
  agentToolScopeChain(agent) {
    return scopeChainOf(scopeOf(agent.ctx));
  }

  /** Bind a temporary read scope, retain no Session, and always release the binding. */
  async presetToolCatalog(presets, id) {
    const existing = this.presetCatalogs.get(id);
    if (existing?.revision === this.catalogRevision && existing.presets === presets) return existing.promise;
    const revision = this.catalogRevision;
    const promise = (async () => {
      const key = {};
      const scope = createScope(this.ctx, key);
      try {
        await presets.mount(scope.ctx, id);
        return this.toolCatalog(key);
      } finally {
        await scope.dispose();
      }
    })();
    const cached = { revision, promise, presets };
    this.presetCatalogs.set(id, cached);
    try {
      return await promise;
    } finally {
      if (this.presetCatalogs.get(id) === cached) this.presetCatalogs.delete(id);
    }
  }
}
