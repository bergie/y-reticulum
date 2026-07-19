This repository is for building a Reticulum connector for Yjs.

We should strive for being roughly on the same level with features as the Yjs WebRTC connector, which can be found in the `y-webrtc/` folder.

## Boundaries

- ✅ **Always**: write at least smoketests for any new functionality
- ✅ **Always**: ensure type safety. Always check eith `npm run types` after changes and fix as needed
- ✅ **Always**: fix formatting with `npm run format` after any changes to source files or tests
- ✅ **Always**: Use `git mv` instead of `mv' for renaming files
- ⚠️ **Ask first**: adding dependencies
- ⚠️ **Ask first**: modify CI config
- 🚫 **Never**: AI agents may not make commits on their own, instead notify user that there are uncommitted changes to review
