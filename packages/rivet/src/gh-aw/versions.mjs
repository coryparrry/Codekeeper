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
  actionsCommit: "6aab9e5b5c91c615506061f09bedd81a23babe3c",
  version: "0.86.2",
  tag: "v0.86.2",
  commit: "48e5fa3ff52294d91d97715017a9f8693a48387f",
  publishedAt: "2026-08-11T16:19:07Z",
  assets,
});

export const GH_AW_UPGRADE_EXPERIMENT = Object.freeze({
  repository: "github/gh-aw",
  actionsCommit: "30aadb1626371455f145991c6385924babda2d04",
  version: "0.86.3",
  tag: "v0.86.3",
  commit: "6062cd2238b68226eb2bfd47607703ed7944330f",
  publishedAt: "2026-08-15T17:18:49Z",
  assets: Object.freeze({
    "darwin-arm64": Object.freeze({
      name: "darwin-arm64",
      size: 30866770,
      sha256:
        "a1dd47d7f0ccfa5e88490bb82bd262e23608be92fafb9b85be2a86283c3a4453",
    }),
    "darwin-x64": Object.freeze({
      name: "darwin-amd64",
      size: 33659072,
      sha256:
        "a5a648490006cef3f47e3896fb92f33179464bea9e23fea25fd0bf483d3236a3",
    }),
    "linux-arm64": Object.freeze({
      name: "linux-arm64",
      size: 30081186,
      sha256:
        "78d9ffda01a3a89866f1d8a9d9bc5d57eb01b8906b103c3122f9e1a4bd4dd03c",
    }),
    "linux-x64": Object.freeze({
      name: "linux-amd64",
      size: 33050786,
      sha256:
        "ebc0e0926b6ce6033b0c0832c405ffde82f4f29813d62bb16ad156d77b362d62",
    }),
    "win32-arm64": Object.freeze({
      name: "windows-arm64.exe",
      size: 30478336,
      sha256:
        "9cf9b99c2def0d920e8e7a2cc1c653053bd85cdd65b9e6de88d59067db1fd5e1",
    }),
    "win32-x64": Object.freeze({
      name: "windows-amd64.exe",
      size: 33832448,
      sha256:
        "85239bdb70092c766a341c265a83295d856d5c1e528c1a36ad08bdb8ec91e165",
    }),
  }),
});
