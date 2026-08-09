const updater = require('../updater');

function release(overrides = {}) {
  return {
    tag_name: 'v1.5.0',
    name: 'v1.5.0',
    html_url: 'https://github.com/JRBlaze/FriendlyChat/releases/tag/v1.5.0',
    published_at: '2026-08-01T10:00:00Z',
    body: 'Fixed a thing.\n\n**Full Changelog**: https://github.com/JRBlaze/FriendlyChat/compare/v1.4.0...v1.5.0',
    draft: false,
    prerelease: false,
    assets: [
      { name: 'Friendly Chat Setup 1.5.0.exe', size: 90000000, browser_download_url: 'https://github.com/JRBlaze/FriendlyChat/releases/download/v1.5.0/Setup.exe' },
      { name: 'Friendly Chat Setup 1.5.0.exe.blockmap', size: 90000, browser_download_url: 'https://github.com/JRBlaze/FriendlyChat/releases/download/v1.5.0/Setup.exe.blockmap' },
      { name: 'Friendly Chat-1.5.0-arm64.dmg', size: 95000000, browser_download_url: 'https://github.com/JRBlaze/FriendlyChat/releases/download/v1.5.0/mac-arm64.dmg' },
      { name: 'Friendly Chat-1.5.0.dmg', size: 96000000, browser_download_url: 'https://github.com/JRBlaze/FriendlyChat/releases/download/v1.5.0/mac.dmg' },
      { name: 'Friendly Chat-1.5.0.AppImage', size: 99000000, browser_download_url: 'https://github.com/JRBlaze/FriendlyChat/releases/download/v1.5.0/linux.AppImage' },
      { name: 'latest.yml', size: 400, browser_download_url: 'https://github.com/JRBlaze/FriendlyChat/releases/download/v1.5.0/latest.yml' },
    ],
    ...overrides,
  };
}

describe('updater: version comparison', () => {
  it('orders released versions correctly', () => {
    assertEqual(updater.compareVersions('1.5.0', '1.4.0'), 1);
    assertEqual(updater.compareVersions('1.4.0', '1.5.0'), -1);
    assertEqual(updater.compareVersions('1.4.0', '1.4.0'), 0);
    assertEqual(updater.compareVersions('1.10.0', '1.9.0'), 1, '10 must beat 9, not sort as a string');
    assertEqual(updater.compareVersions('2.0.0', '1.99.99'), 1);
  });

  it('ignores a leading v and missing segments', () => {
    assertEqual(updater.compareVersions('v1.5.0', '1.5.0'), 0);
    assertEqual(updater.compareVersions('1.5', '1.5.0'), 0);
    assertEqual(updater.compareVersions('v2', '1.9.9'), 1);
  });

  it('sorts a prerelease below its final release', () => {
    assertEqual(updater.compareVersions('1.5.0-beta.1', '1.5.0'), -1);
    assertEqual(updater.compareVersions('1.5.0', '1.5.0-beta.1'), 1);
    assertEqual(updater.compareVersions('1.5.0-beta.2', '1.5.0-beta.1'), 1);
  });

  it('treats junk as 0 instead of throwing', () => {
    assertEqual(updater.compareVersions('', '1.0.0'), -1);
    assertEqual(updater.compareVersions('not-a-version', '0.0.1'), -1);
  });
});

describe('updater: asset selection', () => {
  const assets = release().assets;

  it('picks the installer for each platform', () => {
    assertEqual(updater.pickAsset(assets, 'win32', 'x64').name, 'Friendly Chat Setup 1.5.0.exe');
    assertEqual(updater.pickAsset(assets, 'linux', 'x64').name, 'Friendly Chat-1.5.0.AppImage');
  });

  it('prefers the matching architecture on macOS', () => {
    assertEqual(updater.pickAsset(assets, 'darwin', 'arm64').name, 'Friendly Chat-1.5.0-arm64.dmg');
    assertEqual(updater.pickAsset(assets, 'darwin', 'x64').name, 'Friendly Chat-1.5.0.dmg');
  });

  it('never offers a blockmap or update metadata', () => {
    const onlyMetadata = [
      { name: 'latest.yml', browser_download_url: 'https://github.com/x/y/releases/download/v1/latest.yml' },
      { name: 'Setup.exe.blockmap', browser_download_url: 'https://github.com/x/y/releases/download/v1/Setup.exe.blockmap' },
    ];
    assertEqual(updater.pickAsset(onlyMetadata, 'win32', 'x64'), null);
  });

  it('falls back to a universal build', () => {
    const universal = [
      { name: 'Friendly Chat-1.5.0-universal.dmg', browser_download_url: 'https://github.com/x/y/releases/download/v1/u.dmg' },
    ];
    assertEqual(updater.pickAsset(universal, 'darwin', 'arm64').name, 'Friendly Chat-1.5.0-universal.dmg');
  });

  it('returns null when the platform has no build', () => {
    assertEqual(updater.pickAsset(assets, 'freebsd', 'x64'), null);
    assertEqual(updater.pickAsset([], 'win32', 'x64'), null);
    assertEqual(updater.pickAsset(undefined, 'win32', 'x64'), null);
  });

  it('rejects an asset hosted somewhere other than GitHub', () => {
    const hostile = [{ name: 'Setup.exe', browser_download_url: 'https://evil.example/Setup.exe' }];
    assertEqual(updater.pickAsset(hostile, 'win32', 'x64'), null);
  });

  it('only trusts https GitHub download hosts', () => {
    assert(updater.isAllowedDownloadUrl('https://github.com/a/b/releases/download/v1/x.exe'));
    assert(updater.isAllowedDownloadUrl('https://objects.githubusercontent.com/x'));
    assert(!updater.isAllowedDownloadUrl('http://github.com/a/b'), 'plain http must be refused');
    assert(!updater.isAllowedDownloadUrl('https://github.com.evil.example/x'));
    assert(!updater.isAllowedDownloadUrl('file:///etc/passwd'));
    assert(!updater.isAllowedDownloadUrl(''));
  });
});

describe('updater: building the answer', () => {
  it('reports an available update with the right asset', () => {
    const info = updater.buildUpdateInfo(release(), '1.4.0', 'win32', 'x64');
    assertEqual(info.available, true);
    assertEqual(info.latestVersion, '1.5.0');
    assertEqual(info.currentVersion, '1.4.0');
    assertEqual(info.asset.name, 'Friendly Chat Setup 1.5.0.exe');
    assertEqual(info.asset.size, 90000000);
  });

  it('reports nothing when already current or ahead', () => {
    assertEqual(updater.buildUpdateInfo(release(), '1.5.0', 'win32', 'x64').available, false);
    assertEqual(updater.buildUpdateInfo(release(), '1.6.0', 'win32', 'x64').available, false);
  });

  it('still announces a release with no build for this platform', () => {
    const info = updater.buildUpdateInfo(release(), '1.4.0', 'freebsd', 'x64');
    assertEqual(info.available, true);
    assertEqual(info.asset, null);
    assertEqual(info.reason, 'no-asset-for-platform');
    assertIncludes(info.releaseUrl, '/releases/tag/v1.5.0');
  });

  it('ignores a draft release', () => {
    assertEqual(updater.buildUpdateInfo(release({ draft: true }), '1.4.0', 'win32', 'x64').available, false);
  });

  it('strips the generated changelog footer from the notes', () => {
    const info = updater.buildUpdateInfo(release(), '1.4.0', 'win32', 'x64');
    assertEqual(info.notes, 'Fixed a thing.');
  });

  it('truncates very long notes', () => {
    const long = 'x'.repeat(5000);
    const info = updater.buildUpdateInfo(release({ body: long }), '1.4.0', 'win32', 'x64');
    assert(info.notes.length < 1300, `notes were ${info.notes.length} characters`);
    assertIncludes(info.notes, '…');
  });

  it('copes with a release that has no tag', () => {
    const info = updater.buildUpdateInfo({ assets: [] }, '1.4.0', 'win32', 'x64');
    assertEqual(info.available, false);
    assertEqual(info.reason, 'no-version');
  });
});

describe('updater: fetching', () => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  it('asks the releases/latest endpoint with a GitHub API header', async () => {
    let seen = null;
    await updater.fetchLatestRelease({
      version: '1.4.0',
      fetchImpl: async (url, options) => { seen = { url, options }; return ok(release()); },
    });
    assertEqual(seen.url, updater.RELEASES_API);
    assertEqual(seen.options.headers.Accept, 'application/vnd.github+json');
    assertIncludes(seen.options.headers['User-Agent'], 'FriendlyChat/1.4.0');
  });

  it('explains a rate limit in plain language', async () => {
    await assertRejects(() => updater.fetchLatestRelease({
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    }));
    try {
      await updater.fetchLatestRelease({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
    } catch (e) {
      assertIncludes(e.message, 'rate limit');
    }
  });

  it('explains a repository with no releases', async () => {
    try {
      await updater.fetchLatestRelease({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
      throw new Error('should have thrown');
    } catch (e) {
      assertIncludes(e.message, 'No published releases');
    }
  });

  it('checkForUpdate combines the fetch and the comparison', async () => {
    const info = await updater.checkForUpdate({
      currentVersion: '1.4.0',
      platform: 'linux',
      arch: 'x64',
      fetchImpl: async () => ok(release()),
    });
    assertEqual(info.available, true);
    assertEqual(info.asset.name, 'Friendly Chat-1.5.0.AppImage');
  });
});
