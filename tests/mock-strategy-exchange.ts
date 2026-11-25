const fetchUnmocked=globalThis.fetch;
const identities:Record<string,{userId:string;teamId:string}>={
 A:{userId:'U123ABC1',teamId:'T123ABC1'},
 B:{userId:'U123ABC2',teamId:'T123ABC1'},
 C:{userId:'U123ABC1',teamId:'T123ABC2'}
};

globalThis.fetch=async(input,init)=>{
 if(String(input)==='https://api.muzzle.lol/auth/ah/exchange'){
  const body=JSON.parse(String(init?.body)) as {code?:string};
  const identity=body.code?identities[body.code[0]]:undefined;
  return identity?Response.json({...identity,expiresAt:Date.now()+12*60*60_000}):new Response(null,{status:401});
 }
 return fetchUnmocked(input,init);
};
