# realm-sigil (vendored)

`index.cjs`, `realms.cjs` and `index.d.cts` are copied from [jphein/realm-sigil](https://github.com/jphein/realm-sigil)
`js/index.js`, `js/realms.js` and `js/index.d.ts` at commit `4693abb` (the declarations keep strict TypeScript out of the JS). The only change is the `require('./realms')` path,
renamed for this package's ES-module layout. They stay under realm-sigil's own licence, the GNU LGPL v3
(`COPYING.LESSER`, which extends `COPYING`). The rest of teamclaude is MIT; `src/version-sigil.js` only
calls `generateName()`.

To update: copy the two files again from a newer realm-sigil commit, redo the one `require` rename,
and change the commit above.
