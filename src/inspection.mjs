import { buildOverviewIntelligence } from './overview-intelligence.mjs';
import { compactAlertPrimary, compactAlertSecondary } from './views.mjs';
import { quotaDisplayGroups, quotaLimitTitle } from './quota.mjs';
import { t } from './i18n.mjs';
import { style, truncateAnsi, usedFraction, percent, formatReset, formatDuration, formatMoney, formatPercentPerHour } from './format.mjs';
import { joinPanels, sectionTitle, wrapLines } from './layout.mjs';

const key = (...parts) => JSON.stringify(parts);
const identityValue = value => typeof value === 'string' && value ? value : undefined;

function quotaReportIdentity(report, sourceIndex) {
  const metadata = report?.metadata ?? {};
  const accounts = [
    ['accountKey', metadata.accountKey],
    ['accountId', metadata.accountId],
    ['email', metadata.email],
    ['projectId', metadata.projectId],
    ['orgId', metadata.orgId],
  ].flatMap(([name, value]) => identityValue(value) ? [[name, value]] : []);
  const scopedAccounts = [...new Set((report?.limits ?? [])
    .map(limit => identityValue(limit?.scope?.accountId))
    .filter(Boolean))]
    .map(value => ['scope.accountId', value]);
  const identity = [...accounts, ...scopedAccounts];
  return identity.length ? identity : [['source', sourceIndex]];
}

function quotaBucketIdentity(limit, groupLabel = '') {
  const scope = limit?.scope ?? {};
  const window = scope.windowId || limit?.window?.id || limit?.window?.label || '';
  const shared = scope.sharedGroup || scope.shared === true || /\(shared\)/i.test(limit?.label ?? '');
  if (shared) return ['shared', scope.sharedGroup || groupLabel || limit?.label || '', window];
  return ['limit', limit?.id || limit?.label || 'quota', scope.model || scope.modelId || '', scope.tier || '', window];
}

export function quotaEntryIdentity(report, limit, groupLabel = '', sourceIndex = 0) {
  return key(report?.provider, quotaReportIdentity(report, sourceIndex), quotaBucketIdentity(limit, groupLabel));
}

const FIELD_LABELS = {
  errorRate: 'metric.err', avgTtft: 'metric.ttft', avgDuration: 'metric.latency', avgTokensPerSecond: 'metric.tps', totalCost: 'metric.apiEst',
  provider: 'metric.provider', model: 'metric.model', agentType: 'explore.agent', folder: 'explore.project', sessionFile: 'explore.session',
  totalRequests: 'metric.requests', requests: 'metric.requests', totalInputTokens: 'metric.input', totalOutputTokens: 'metric.output',
  uncachedInputTokens: 'explore.uncached', cacheReadTokens: 'metric.cacheRead', cacheWriteTokens: 'metric.cacheWrite',
  totalCacheReadTokens: 'metric.cacheRead', totalCacheWriteTokens: 'metric.cacheWrite', cacheRate: 'metric.cacheHit',
};
export const inspectionFields = row => Object.entries(row ?? {}).filter(([, value]) => value != null && typeof value !== 'object')
  .map(([name, value]) => `${FIELD_LABELS[name] ? t(FIELD_LABELS[name]) : name}: ${['cacheRate','errorRate','usedFraction','remainingFraction','uncachedShare'].includes(name) ? percent(value) : ['avgTtft','avgDuration'].includes(name) ? formatDuration(value) : name === 'totalCost' ? formatMoney(value) : ['recentBurnPerHour','burnPerHour','sustainablePerHour'].includes(name) ? formatPercentPerHour(value) : String(value)}`);
const fields = inspectionFields;

function modelDetail(row, context) {
  const detail = fields(row);
  const omp = context.ompStats?.byModel?.find(candidate => candidate.provider === row.provider && candidate.model === row.model);
  if (omp) {
    const performance = Object.fromEntries(['errorRate','failedRequests','avgTtft','avgDuration','avgTokensPerSecond','totalCost']
      .filter(name => Number.isFinite(omp[name])).map(name => [name, omp[name]]));
    if (Object.keys(performance).length) detail.push('', t('window.ompMetrics'), ...fields(performance));
  }
  return detail;
}

export function inspectionEntries(view, context) {
  if (view === 'overview') return buildOverviewIntelligence(context).alerts.map(alert => ({
    id: key(alert.kind, alert.provider, alert.model, alert.quota?.limit?.id, alert.agentType),
    title: compactAlertPrimary(alert, context.now),
    detail: [compactAlertPrimary(alert, context.now), compactAlertSecondary(alert), ...fields(alert)],
    alert,
  }));
  if (view === 'quota') return (context.quota?.reports ?? []).flatMap((report, sourceIndex) =>
    quotaDisplayGroups(report).flatMap(group => group.limits.map(limit => ({
      id: quotaEntryIdentity(report, limit, group.label, sourceIndex),
      title: `${report.provider} · ${quotaLimitTitle(limit)} · ${percent(usedFraction(limit.amount ?? {}))}`,
      detail: [report.provider, ...fields(report.metadata), quotaLimitTitle(limit), ...fields(limit.amount),
        formatReset(limit.window?.resetsAt, context.now), ...(limit.notes ?? []), ...(report.notes ?? []), ...fields(limit.intelligence)],
      provider: report.provider, model: limit.scope?.modelId, limit, report,
    }))));
  if (view === 'models' || view === 'cache') return (context.stats?.byModel ?? []).map(row => ({
    id: key(row.provider, row.model), title: `${row.provider} / ${row.model}`, detail: modelDetail(row, context),
    provider: row.provider, model: row.model, row,
  }));
  if (view === 'agents') return (context.stats?.byAgentType ?? []).map(row => ({
    id: key(row.agentType), title: row.agentType, detail: fields(row), agentType: row.agentType, row,
  }));
  return [...(context.events ?? [])].reverse().map(event => ({
    id: key(event.at, event.level, event.message), title: `${event.level} · ${event.message}`, detail: fields(event),
  }));
}

export function renderInspection(entries, state, width, height) {
  const index = Math.max(0, entries.findIndex(row => row.id === state.selected));
  const selected = entries[index];
  state.selected = selected?.id;
  const split = width >= 116 && height >= 12;
  const listWidth = split ? Math.min(80, Math.floor((width - 3) * .42)) : width;
  const detailWidth = split ? width - listWidth - 3 : width;
  const listHeight = Math.max(1, split ? height - 1 : Math.min(5, Math.floor((height - 2) / 2)));
  const offset = Math.max(0, index - listHeight + 1);
  const list = [sectionTitle(t('inspect.rows', { current: selected ? index + 1 : 0, total: entries.length }), listWidth)];
  for (let i = offset; i < Math.min(entries.length, offset + listHeight); i++) {
    const title = truncateAnsi(`${i === index ? '▸' : ' '} ${entries[i].title}`, listWidth);
    list.push(i === index ? style.inverse(title) : title);
  }
  if (!selected) list.push(...wrapLines([state.emptyMessage ?? t('inspect.empty')], listWidth));
  const allDetail = wrapLines(state.help ? [t('explore.help')] : selected?.detail ?? fields(state.scope), detailWidth);
  const detailHeight = Math.max(1, split ? height - 1 : height - list.length - 2);
  state.detailOffset = Math.max(0, Math.min(state.detailOffset ?? 0, allDetail.length - detailHeight));
  const detail = [sectionTitle(t('inspect.detail', { current: allDetail.length ? state.detailOffset + 1 : 0, total: allDetail.length }), detailWidth),
    ...allDetail.slice(state.detailOffset, state.detailOffset + detailHeight)];
  return (split ? joinPanels(list, detail, listWidth, detailWidth) : [...list, '', ...detail]).slice(0, height);
}
