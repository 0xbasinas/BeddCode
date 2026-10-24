# Winget

`manifests/` is the first submission (0.1.0) for `microsoft/winget-pkgs`, package `BeddCode.BeddCode`.

## First submission (by hand)

1. Check the manifests: `winget validate --manifest packaging/winget/manifests/b/BeddCode/BeddCode/0.1.0`
2. Try the install locally: `winget settings --enable LocalManifestFiles`, then
   `winget install --manifest packaging/winget/manifests/b/BeddCode/BeddCode/0.1.0`
3. Fork `microsoft/winget-pkgs`, copy `manifests/b/BeddCode` into the fork's `manifests/b/`, and open a
   pull request. Its pipeline installs the app in a clean VM and scans it; fix whatever it reports.

## Every release after that

`.github/workflows/winget.yml` opens the pull request when a release is published, with Microsoft's
`wingetcreate` (downloaded from aka.ms on the runner). One-time setup:
fork `microsoft/winget-pkgs` and add a `WINGET_TOKEN` repository secret (a classic personal access token
with `public_repo`). Until the first submission is merged the action has nothing to update.

## Signing

The installer is unsigned unless `CSC_LINK` and `CSC_KEY_PASSWORD` are set in the release workflow.
Winget accepts unsigned installers, but SmartScreen and Defender are harsher on them and validation may
need a manual review.
