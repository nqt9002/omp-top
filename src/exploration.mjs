import { inspectionEntries, inspectionFields, quotaEntryIdentity } from './inspection.mjs';
import { t } from './i18n.mjs';

const identity = (...values) => JSON.stringify(values);
const scalarDetail = inspectionFields;
export const SORT_ORDERS = ['source', 'name', 'requests', 'usage'];

function scopeMatches(entry, scope = {}) {
  return Object.entries(scope).every(([field, value]) => value === undefined || entry[field] === value);
}

export function exploreEntries(view, context, state = {}) {
  let entries;
  const scope = state.scope ?? {};
  if (view === 'cache' && ['projects', 'sessions'].includes(state.level)) {
    const rows = context.cacheDiagnostics?.[state.level === 'projects' ? 'byFolderModel' : 'bySessionModel'] ?? [];
    entries = rows.map(row => ({
      ...row, id: identity(row.provider, row.model, row.folder, row.sessionFile),
      title: state.level === 'projects' ? row.folder || t('explore.unnamed') : row.sessionFile || t('explore.unnamed'),
      detail: scalarDetail(row), row,
      target: state.level === 'projects' ? { view: 'cache', level: 'sessions', scope: { provider: row.provider, model: row.model, folder: row.folder } } : undefined,
    }));
  } else {
    entries = inspectionEntries(view, context).map(entry => {
      if (entry.alert) {
        const alert = entry.alert;
        const targetScope = { provider: alert.provider, model: alert.model, agentType: alert.agentType };
        const target = { view: ['overview','quota','models','cache','agents','events'][Number(alert.viewKey) - 1] ?? 'overview', scope: targetScope };
        if (alert.quota) {
          const reports = context.quota?.reports ?? [];
          const sourceIndex = reports.indexOf(alert.quota.report);
          if (sourceIndex >= 0) {
            target.selected = quotaEntryIdentity(alert.quota.report, alert.quota.limit, alert.quota.groupLabel, sourceIndex);
          }
        }
        return { ...entry, provider: alert.provider, model: alert.model, agentType: alert.agentType, target };
      }
      if ((view === 'models' || view === 'cache') && entry.model) return {
        ...entry, target: { view: 'cache', level: 'projects', scope: { provider: entry.provider, model: entry.model } },
      };
      return entry;
    });
  }
  entries = entries.filter(entry => scopeMatches(entry, scope));
  const providers = [...new Set(entries.map(entry => entry.provider).filter(Boolean))].sort();
  if (state.provider) entries = entries.filter(entry => entry.provider === state.provider);
  entries = filterEntries(entries, state.query);
  const sort = state.sort ?? 'source';
  const number = (entry, name) => Number(entry.row?.[name] ?? entry[name] ?? 0);
  if (sort === 'name') entries.sort((a,b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  if (sort === 'requests') entries.sort((a,b) => (number(b,'totalRequests') || number(b,'requests')) - (number(a,'totalRequests') || number(a,'requests')) || a.id.localeCompare(b.id));
  if (sort === 'usage') entries.sort((a,b) => (Number(b.limit?.amount?.usedFraction) || number(b,'uncachedInputTokens') || number(b,'totalInputTokens')) - (Number(a.limit?.amount?.usedFraction) || number(a,'uncachedInputTokens') || number(a,'totalInputTokens')) || a.id.localeCompare(b.id));
  return { entries, providers, reason: view === 'cache' && state.level && !context.cacheDiagnostics ? t('explore.noDiagnostics') : undefined };
}

export function filterEntries(entries, query = '') {
  const aliases = { provider: 'provider', model: 'model', project: 'folder', session: 'sessionFile', agent: 'agentType' };
  const tokens = String(query).match(/(?:[^\s"]+|"[^"]*")+/gu) ?? [];
  return entries.filter(entry => tokens.every(token => {
    const match = token.match(/^(provider|model|project|session|agent):(.*)$/iu);
    const needle = (match ? match[2] : token).replace(/"/g, '').toLocaleLowerCase();
    const haystack = match ? String(entry[aliases[match[1].toLowerCase()]] ?? '') : [entry.title, ...(entry.detail ?? [])].join(' ');
    return haystack.toLocaleLowerCase().includes(needle);
  }));
}
