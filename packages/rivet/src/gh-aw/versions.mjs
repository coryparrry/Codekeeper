const assets = Object.freeze({
  "darwin-arm64": Object.freeze({
    name: "darwin-arm64",
    size: 30682610,
    sha256: "ea38d02b6126ffe9a0c006111f2b17d6a36024ff8bf09c326e448a8537d8ad93",
  }),
  "darwin-x64": Object.freeze({
    name: "darwin-amd64",
    size: 33464112,
    sha256: "2fded8bb2ea5cf4e622c1d9b049f67d97ce6804ed174af5eb72b1a5227cbd294",
  }),
  "linux-arm64": Object.freeze({
    name: "linux-arm64",
    size: 29884578,
    sha256: "1f70570ef24248d37a3e6833e77af5b430f46ebb98c2c522f3e0dc1f93bafda6",
  }),
  "linux-x64": Object.freeze({
    name: "linux-amd64",
    size: 32862370,
    sha256: "b8fd100d1d56a77b842ad28375ff361215a5aa1277db6b9a05d70054cde7260e",
  }),
  "win32-arm64": Object.freeze({
    name: "windows-arm64.exe",
    size: 30303232,
    sha256: "8b02daa84568b767f20ebb793dce1639e19ce687499ab410b6cc12380d55ea5c",
  }),
  "win32-x64": Object.freeze({
    name: "windows-amd64.exe",
    size: 33640960,
    sha256: "1ddfeabde198be39f277001ce4f3daea33366cf98aae7e0a9db3d615bc9df174",
  }),
});

export const GH_AW_RELEASE = Object.freeze({
  repository: "github/gh-aw",
  version: "0.86.2",
  tag: "v0.86.2",
  commit: "48e5fa3ff52294d91d97715017a9f8693a48387f",
  publishedAt: "2026-08-11T16:19:07Z",
  assets,
});
