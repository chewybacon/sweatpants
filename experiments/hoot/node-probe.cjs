const { Scheme } = require('./runtime/reflect.js');
(async () => {
  const [start, next] = await Scheme.load_main(__dirname + '/runtime/kernel.wasm', {reflect_wasm_dir: __dirname + '/runtime'});
  console.log(start.call('(let ((n (effect "random" "1..6"))) (let ((answer (effect "ask" "Your name?"))) (string-append answer ":" (number->string n))))'));
  console.log(next.call(4));
  console.log(next.call('Ada'));
})().catch(e => { console.error(e); process.exitCode = 1; });
