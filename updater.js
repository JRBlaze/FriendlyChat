// Friendly Chat - update checking
//
// Releases are published to GitHub by .github/workflows/build.yml as an .exe,
// a .dmg and an .AppImage. This module answers one question: given the running
// version and platform, is there a newer release and which file should be
// downloaded?
//
// electron-updater is deliberately not used. The macOS builds are unsigned
// (CSC_IDENTITY_AUTO_DISCOVERY is off in the workflow), and unsigned macOS apps
// cannot silently self-update — so the app downloads the installer and hands it
// to the OS instead, which behaves the same way on all three platforms and adds
// no runtime dependency.

const GITHUB_OWNER = 'JRBlaze';
const GITHUB_REPO  = 'FriendlyChat';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

// Hosts an update download is allowed to come from.
const ALLOWED_DOWNLOAD_HOSTS = [
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];

function isAllowedDownloadUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    if (url.protocol !== 'https:') return false;
    return ALLOWED_DOWNLOAD_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch (_) {
    return false;
  }
}

// ── Version comparison ───────────────────────────────────────────────────────

// Splits "v1.4.0-beta.2" into { numbers: [1,4,0], pre: "beta.2" }.
function parseVersion(value) {
  const text = String(value || '').trim().replace(/^v/i, '');
  const [core, pre = ''] = text.split('-');
  const numbers = core.split('.').map(part => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  while (numbers.length < 3) numbers.push(0);
  return { numbers: numbers.slice(0, 3), pre };
}

// Standard semver ordering: -1 if a < b, 0 if equal, 1 if a > b.
// A prerelease sorts below the release it leads to (1.5.0-beta < 1.5.0).
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] < right.numbers[i] ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

// ── Asset selection ──────────────────────────────────────────────────────────

const PLATFORM_EXTENSIONS = {
  win32:  ['.exe'],
  darwin: ['.dmg'],
  linux:  ['.appimage'],
};

// electron-builder also publishes blockmaps and update metadata next to the
// installers; neither is something a person should be handed.
function isInstallerAsset(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.blockmap') || lower.endsWith('.yml') || lower.endsWith('.yaml')) return false;
  return true;
}

// Picks the file matching this platform, preferring an exact architecture match
// (an Apple Silicon build should not hand back the Intel dmg when both exist).
function pickAsset(assets, platform, arch) {
  const extensions = PLATFORM_EXTENSIONS[platform];
  if (!extensions || !Array.isArray(assets)) return null;

  const candidates = assets.filter(asset => {
    const name = String(asset?.name || '').toLowerCase();
    return isInstallerAsset(name) && extensions.some(ext => name.endsWith(ext));
  });
  if (!candidates.length) return null;

  const wantedArch = String(arch || '').toLowerCase();
  const archAliases = wantedArch === 'arm64' ? ['arm64', 'aarch64']
    : wantedArch === 'x64' ? ['x64', 'x86_64', 'amd64']
      : [wantedArch].filter(Boolean);

  const mentionsAnyArch = (name) =>
    /(arm64|aarch64|x64|x86_64|amd64|ia32|universal)/.test(name);

  const exact = candidates.find(asset => {
    const name = String(asset.name).toLowerCase();
    return archAliases.some(alias => name.includes(alias));
  });
  if (exact) return normalizeAsset(exact);

  const universal = candidates.find(asset => String(asset.name).toLowerCase().includes('universal'));
  if (universal) return normalizeAsset(universal);

  // A file with no architecture in its name is the single-arch build.
  const neutral = candidates.find(asset => !mentionsAnyArch(String(asset.name).toLowerCase()));
  return normalizeAsset(neutral || candidates[0]);
}

function normalizeAsset(asset) {
  if (!asset) return null;
  const url = asset.browser_download_url || asset.url || '';
  if (!isAllowedDownloadUrl(url)) return null;
  return {
    name: asset.name || 'installer',
    url,
    size: Number(asset.size) || 0,
  };
}

// ── Release lookup ───────────────────────────────────────────────────────────

async function fetchLatestRelease({ fetchImpl = fetch, version = '' } = {}) {
  const res = await fetchImpl(RELEASES_API, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `FriendlyChat/${version || 'unknown'}`,
    },
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub rate limit reached — try again later');
  }
  if (res.status === 404) {
    throw new Error('No published releases found');
  }
  if (!res.ok) {
    throw new Error(`GitHub returned HTTP ${res.status}`);
  }
  return res.json();
}

// Trims release notes to something that fits in a panel without becoming a wall
// of text, and drops the noise GitHub's generated notes add.
function tidyNotes(body, limit = 1200) {
  const text = String(body || '')
    .replace(/\r\n/g, '\n')
    .replace(/^\*\*Full Changelog\*\*.*$/gm, '')
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n…`;
}

// Turns a release payload into the answer the app actually needs.
function buildUpdateInfo(release, currentVersion, platform, arch) {
  const latestVersion = String(release?.tag_name || release?.name || '').replace(/^v/i, '');
  const releaseUrl = release?.html_url || RELEASES_PAGE;

  if (!latestVersion) {
    return { available: false, currentVersion, latestVersion: '', releaseUrl, reason: 'no-version' };
  }
  if (release?.draft) {
    return { available: false, currentVersion, latestVersion, releaseUrl, reason: 'draft' };
  }

  const newer = compareVersions(latestVersion, currentVersion) > 0;
  const asset = newer ? pickAsset(release?.assets, platform, arch) : null;

  return {
    available: newer,
    currentVersion,
    latestVersion,
    name: release?.name || release?.tag_name || '',
    notes: tidyNotes(release?.body),
    releaseUrl,
    publishedAt: release?.published_at || '',
    prerelease: !!release?.prerelease,
    asset,
    // A release with no file for this platform is still worth announcing — the
    // user can go to the release page — it just cannot be downloaded in-app.
    reason: newer && !asset ? 'no-asset-for-platform' : '',
  };
}

async function checkForUpdate({ currentVersion, platform, arch, fetchImpl = fetch } = {}) {
  const release = await fetchLatestRelease({ fetchImpl, version: currentVersion });
  return buildUpdateInfo(release, currentVersion, platform, arch);
}

module.exports = {
  GITHUB_OWNER,
  GITHUB_REPO,
  RELEASES_API,
  RELEASES_PAGE,
  ALLOWED_DOWNLOAD_HOSTS,
  isAllowedDownloadUrl,
  parseVersion,
  compareVersions,
  pickAsset,
  tidyNotes,
  buildUpdateInfo,
  fetchLatestRelease,
  checkForUpdate,
};
