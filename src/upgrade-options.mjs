import { compareVersions, parseVersion, versionChannel } from './release-policy.mjs';
import { t } from './i18n.mjs';

/** Channel selection is per invocation; there is no hidden/sticky beta opt-in. */
export function upgradeSelection({ channel, tag } = {}) {
  if (channel !== undefined && !['stable', 'beta'].includes(channel)) throw new Error('--channel must be stable or beta');
  if (tag !== undefined && channel !== undefined) throw new Error('Use --tag OR --channel, not both');
  if (tag !== undefined) {
    const version = parseVersion(tag).version;
    return { tag: `v${version}`, channel: versionChannel(version), explicit: true };
  }
  return { tag: undefined, channel: channel ?? 'stable', explicit: channel !== undefined };
}

export function upgradeDecision(current, target, selection) {
  const order = compareVersions(target, current);
  if (order === 0) return { update: false, message: t("upgrade.upToDate", { version: current }) };
  if (order > 0 || selection.tag) return { update: true };
  if (selection.channel === 'stable' && versionChannel(current) !== 'stable') {
    if (selection.explicit) return { update: true, switching: true };
    return { update: false, message: t("upgrade.leaveBeta", { target, current }) };
  }
  return { update: false, message: t("upgrade.noDowngrade", { current, channel: selection.channel, target }) };
}

export function parseOptions(argv) {
  const result = { command: 'run', redact: false, profile: undefined, quotaTimeout: undefined, channel: undefined, tag: undefined, language: undefined, help: false, version: false };
  let commandSet = false;
  const seen = new Set();
  const once = name => { if (seen.has(name)) throw new Error(`Duplicate option: ${name}`); seen.add(name); };
  const valueAt = (i, name) => {
    const value = argv[i + 1];
    if (!value || value.startsWith('-')) throw new Error(`${name} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['run', 'install', 'upgrade', 'uninstall', 'language'].includes(arg)) {
      if (commandSet) throw new Error('Choose one command');
      result.command = arg; commandSet = true; continue;
    }
    if (result.command === 'language' && result.language === undefined && !arg.startsWith('-')) { result.language = arg; continue; }
    if (arg === '--redact') { result.redact = true; continue; }
    if (arg === '--profile') { once(arg); result.profile = valueAt(i++, arg); continue; }
    if (arg === '--quota-timeout') {
      once(arg); result.quotaTimeout = valueAt(i++, arg);
      if (!/^\d+$/.test(result.quotaTimeout) || !Number.isSafeInteger(Number(result.quotaTimeout))) throw new Error('--quota-timeout must be a non-negative integer in milliseconds');
      continue;
    }
    if (arg === '--channel') { once(arg); result.channel = valueAt(i++, arg); continue; }
    if (arg === '--tag') { once(arg); result.tag = valueAt(i++, arg); continue; }
    if (arg === '-h' || arg === '--help') { result.help = true; continue; }
    if (arg === '-v' || arg === '--version') { result.version = true; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  upgradeSelection(result); // Validate before any network or filesystem mutation.
  if (result.command !== 'upgrade' && (result.channel !== undefined || result.tag !== undefined)) throw new Error('--channel and --tag are upgrade options');
  if (result.command !== 'language' && result.language !== undefined) throw new Error('Language value requires the language command');
  return result;
}
