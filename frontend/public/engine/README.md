# In-browser Stockfish

`stockfish.wasm.js` + `stockfish.wasm` are stockfish.js 10.0.2 (Stockfish
2019-08-15, WebAssembly build by Niklas Fiekas, GPL-3.0 — see Copying.txt),
loaded as a Web Worker by `lib/browserEngine.ts`. The .wasm must stay
side-by-side with the .js glue (it loads relative to the worker script).

These files are served as static assets and only download when sparring or
try-it-yourself starts — they add nothing to the JS bundle. They power
engine replies and autoplay in the browser so that compute stays off the VPS;
the backend /api/position endpoint remains the source of classifier
explanations for played moves.
