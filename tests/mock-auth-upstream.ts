const originalFetch=globalThis.fetch;
const used=new Set<string>();
globalThis.fetch=async(input,init)=>{
 if(String(input)==='https://api.muzzle.lol/auth/ah/exchange'){
  const {code}=JSON.parse(String(init?.body)) as {code:string};
  if(used.has(code))return new Response('',{status:401});
  used.add(code);
  return Response.json({userId:'U1',teamId:'T1',expiresAt:Date.now()+60_000});
 }
 return originalFetch(input,init);
};
