# Inter (vendored)

The Latin and Latin Extended subsets of Inter Variable, taken unchanged from
`@fontsource-variable/inter` 5.3.0 (SIL Open Font License 1.1, see `LICENSE.txt`).
`inter.css` is that package's `@font-face` rules for those two files. The app bundles the
font so the interface looks the same on macOS, Windows and Linux without a network request
(the CSP's `font-src 'self'` covers it). To update, copy the same two files from a newer
release and keep the `unicode-range` lines in step with the package's `wght.css`.
