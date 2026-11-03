// SDK 0.0.16 prints complete incoming envelopes, including PCM. Keep these out
// of normal console capture; our bounded diagnostics record aggregate counts.
for (const level of ['log','debug','info','warn','error'] as const) {
  const original=console[level].bind(console)
  console[level]=(...args:unknown[])=>{
    if(typeof args[0]==='string'&&args[0].startsWith('[EvenAppBridge]'))return
    original(...args)
  }
}
