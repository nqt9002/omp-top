import { t } from './i18n.mjs';
import { compactNumber, style } from './format.mjs';
import { sectionTitle, wrapLines } from './layout.mjs';

export function windowSummary({ hours, result, loading }) {
  return t(loading ? 'window.loading' : result?.available ? 'window.observed' : hours === 24 ? 'window.fallback' : 'window.unavailable', { hours });
}

export function renderComparison({ hours, result, loading }, width) {
  const lines = [sectionTitle(t('window.compare', { hours }), width), windowSummary({ hours, result, loading }), '', t('window.quotaSnapshot'), t('window.compareScope')];
  const comparison = result?.comparison;
  if (!comparison?.available) return wrapLines([...lines, '', t('window.noComparison'), comparison?.reason ?? ''], width);
  lines.push('', t('window.coverage'));
  for (const [key, metric] of Object.entries(comparison.metrics)) {
    const change = metric.percentChange == null ? t('window.noBaseline') : `${metric.percentChange >= 0 ? '+' : ''}${metric.percentChange.toFixed(1)}%`;
    lines.push('', style.bold(t(`window.${key}`)), t('window.values', {
      current: compactNumber(metric.current), previous: compactNumber(metric.previous),
      delta: `${metric.delta >= 0 ? '+' : ''}${compactNumber(metric.delta)}`, change,
    }));
  }
  return wrapLines(lines, width);
}
