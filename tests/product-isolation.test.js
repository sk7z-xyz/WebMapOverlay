const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {publicKeyDetails, loadTrustedKeys, signingData, verifyEnvelope, installerName, assertUpdateMatches} = require('../update-signature');

test('Bridge signatures and product manifests cannot be used as Overlay releases with the same key', () => {
  const pair = crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const publicKey = pair.publicKey.export({type:'spki',format:'pem'});
  const {id} = publicKeyDetails(publicKey);
  const keys = loadTrustedKeys({schema:'webmapoverlay.trusted-keys.v1',keys:[{id,publicKey}]});
  const payload = {schema:'webmapoverlay.release.v1',version:'1.1.2',filename:installerName('1.1.2'),size:1,sha512:Buffer.alloc(64).toString('base64')};
  const envelope = (content, domain, schema='webmapoverlay.signature.v1') => {
    const bytes = Buffer.from(JSON.stringify(content));
    return JSON.stringify({schema,keyId:id,payload:bytes.toString('base64'),signature:crypto.sign('sha256',Buffer.concat([Buffer.from(domain),bytes]),pair.privateKey).toString('base64')});
  };
  assert.deepEqual(verifyEnvelope(envelope(payload,'WebMapOverlay release signature v1\n'), keys), payload);
  assert.throws(() => verifyEnvelope(envelope(payload,'WebMapBridge release signature v1\n'),keys));
  assert.throws(() => verifyEnvelope(envelope(payload,'WebMapBridge release signature v1\n','webmapbridge.signature.v1'),keys));
  assert.throws(() => verifyEnvelope(envelope({...payload,schema:'webmapbridge.release.v1'},'WebMapOverlay release signature v1\n'),keys));
  assert.throws(() => verifyEnvelope(envelope({...payload,filename:'WebMapBridge-1.1.2-Installer.exe'},'WebMapOverlay release signature v1\n'),keys));
  assert.throws(() => assertUpdateMatches(payload,{version:'1.1.2',files:[{url:payload.filename,size:2,sha512:payload.sha512}]},'1.1.1'));
  assert.throws(() => assertUpdateMatches(payload,{version:'1.1.2',files:[{url:payload.filename,size:1,sha512:payload.sha512}]},'1.1.2'));
});

test('release keys are the two published Bridge keys', () => {
  const keys = require('../update-trusted-keys.json');
  assert.deepEqual(keys.keys.map(k => k.id), ['5dff5226ed4e5414e9bdd37248f38626e13b9e6b89c758495fe63dbb2bd6f743','0b6eb749bf8735bdc5de9c9e38d7aae19b0322efc8d838872ff4bb3c628290be']);
  assert.equal(loadTrustedKeys(keys).size, 2);
});
