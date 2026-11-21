// WebCrypto helpers for encrypted customer OAuth tokens and opaque sessions.
const encoder=new TextEncoder();
const decoder=new TextDecoder();
export function randomToken(bytes=32){
  const raw=crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(raw,b=>b.toString(16).padStart(2,"0")).join("");
}
export async function sha256(text){
  const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(text)));
  return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
}
function decodeKey(text){
  if(typeof text!=="string"||!/^[a-f0-9]{64}$/i.test(text))throw Error("Encryption key must be 32 hexadecimal bytes");
  return Uint8Array.from(text.match(/.{2}/g),part=>parseInt(part,16));
}
const keyFor=secret=>crypto.subtle.importKey("raw",decodeKey(secret),"AES-GCM",false,["encrypt","decrypt"]);
export async function seal(secret,plaintext,aad){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const bytes=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:encoder.encode(aad)},await keyFor(secret),encoder.encode(plaintext)));
  return Buffer.from(new Uint8Array([...iv,...bytes])).toString("base64url");
}
export async function unseal(secret,ciphertext,aad){
  const data=Buffer.from(ciphertext,"base64url");
  if(data.length<29)throw Error("Encrypted credential is corrupt");
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:data.subarray(0,12),additionalData:encoder.encode(aad)},await keyFor(secret),data.subarray(12));
  return decoder.decode(plain);
}
