#!/usr/bin/env bun
import { installSelf, uninstallSelf, upgradeSelf, readPackageVersion } from './self.mjs';
import { parseOptions, upgradeSelection } from './upgrade-options.mjs';
import { versionChannel } from './release-policy.mjs';
import { getLocale, localeLabel, setLocale, t } from './i18n.mjs';
import { resolveLocale, writeLanguage } from './preferences.mjs';

setLocale(await resolveLocale());

function help() {
  return `omp-top - ${t("cli.description")}

${t("cli.usage")}:
  omp-top [run] [--profile NAME] [--redact] [--quota-timeout MS]
  omp-top install
  omp-top upgrade [--channel stable|beta | --tag vX.Y.Z[-beta.N]]
  omp-top language [en|vi]
  omp-top uninstall

${t("cli.upgrade")}:
  --channel stable     ${t("cli.channelStable")}
  --channel beta       ${t("cli.channelBeta")}
  --tag TAG            ${t("cli.tag")}

${t("cli.channelNote")}
${t("cli.returnStable")}
${t("cli.independence")}

${t("cli.language")}:
  omp-top language     ${t("cli.languageHelp")}
  omp-top language en
  omp-top language vi
  OMP_TOP_LANG=en|vi  ${t("cli.langOverride")}

${t("cli.monitor")}:
  --profile NAME       ${t("cli.profile")}
  --redact             ${t("cli.redact")}
  --quota-timeout MS   ${t("cli.quotaTimeout")}
  -v, --version        ${t("cli.version")}
  -h, --help           ${t("cli.help")}

${t("cli.keys")}
`;
}

let options;
try { options = parseOptions(process.argv.slice(2)); }
catch (error) { process.stderr.write(`${error.message}\n\n${help()}`); process.exit(2); }

if (options.help) { process.stdout.write(help()); process.exit(0); }
if (options.version) {
  const version = await readPackageVersion();
  process.stdout.write(`omp-top ${version}\n${t("cli.channelLabel")}: ${versionChannel(version)}\n${t("cli.languageLabel")}: ${getLocale()}\n`);
  process.exit(0);
}

if (options.command === 'language') {
  try {
    if (options.language) {
      const saved = await writeLanguage(options.language);
      setLocale(saved.locale);
      process.stdout.write(t("language.changed", { language: localeLabel(saved.locale), locale: saved.locale }) + "\n");
    } else {
      const locale = getLocale();
      process.stdout.write(t("language.current", { language: localeLabel(locale), locale }) + "\n");
      process.stdout.write(t("language.supported") + "\n");
    }
    process.exit(0);
  } catch (error) {
    process.stderr.write(t("language.invalid", { locale: options.language ?? "" }) + "\n");
    process.exit(2);
  }
}

try {
  if (options.command === 'install') {
    const installed = await installSelf();
    process.stdout.write(t("cli.installed", { version: installed.version, channel: versionChannel(installed.version) }) + "\n" + installed.launcherPath + "\n");
    if (!String(process.env.PATH || '').split(':').includes(installed.launcherPath.replace(/\/omp-top$/, ''))) {
      process.stdout.write("\n" + t("cli.addPath") + "\n");
    }
    process.exit(0);
  }
  if (options.command === 'uninstall') {
    const result = await uninstallSelf();
    process.stdout.write(t("cli.removed", { path: result.installDir }) + "\n");
    process.exit(0);
  }
  if (options.command === 'upgrade') {
    const selection = upgradeSelection(options);
    process.stdout.write(t("cli.checking", { target: selection.tag || selection.channel }) + "\n");
    await upgradeSelf(options);
    process.exit(0);
  }
} catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }

if (options.profile?.trim()) process.env.OMP_PROFILE = options.profile.trim();
if (options.quotaTimeout !== undefined) process.env.OMP_TOP_QUOTA_HARD_TIMEOUT_MS = options.quotaTimeout;
if (!process.stdin?.isTTY || !process.stdout?.isTTY) {
  process.stderr.write(t("cli.ttyRequired") + "\n"); process.exit(1);
}
const version = await readPackageVersion();
const { OmpTopApp } = await import('./top.mjs');
const app = new OmpTopApp({ redact: options.redact, version, channel: versionChannel(version) });
const cleanup = () => app.dispose();
process.once('exit', cleanup);
try { await app.run(); }
finally { process.off('exit', cleanup); app.dispose(); }
