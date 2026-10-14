# Official Quark runtime

`quarkclouddrive-1.0.24.zip` is an unmodified copy of the official runtime,
bundled so GitHub jobs can start when the vendor download CDN is unavailable.
It contains code and documentation only, with no account state or credentials.

- Official project: https://github.com/quark-clouddrive/quarkclouddrive_offical
- Original package: https://pdds.quark.cn/download/stfile/fflliomikfgjfhnhk/quarkclouddrive-1.0.24.zip
- CLI version: `1.0.24-29460f9`
- SHA-256: `a4847bb6e4d6bafb21eb28ba0d9b34b643b6ba5aed44d1a25c86c7f5ba3efb8a`
- Copyright 2026 quark clouddrive. Apache License 2.0; see `LICENSE` in this directory.

The bootstrap verifies the same pinned SHA-256 for both the bundled copy and
an official download before extracting or executing the runtime.
