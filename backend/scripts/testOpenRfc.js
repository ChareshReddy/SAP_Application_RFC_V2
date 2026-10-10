import {
  getRfcConnectionParams,
  pingRfcServer,
  rfcReadBom,
  rfcValidateSourceBom
} from '../services/sapRfcClient.js';

async function runDiagnostic() {
  console.log('===============================================================');
  console.log('SAP RFC / BAPI Connectivity & Function Module Diagnostic');
  console.log('===============================================================');

  const params = getRfcConnectionParams();
  console.log('Target System Parameters:');
  console.log(`  Router:     ${params.saprouter || 'None'}`);
  console.log(`  App Server: ${params.ashost}`);
  console.log(`  Sys Number: ${params.sysnr}`);
  console.log(`  Gateway:    ${params.gwserv || '33' + params.sysnr}`);
  console.log(`  Client:     ${params.client}`);
  console.log(`  User:       ${params.user}`);
  console.log(`  Language:   ${params.lang}`);
  console.log(`  Password:   ${params.passwd ? '********' : 'Not set'}`);
  console.log('---------------------------------------------------------------');

  console.log('\n[1/3] Pinging SAP RFC Gateway (RFC_PING)...');
  const ping = await pingRfcServer();
  console.log('Ping Result:', JSON.stringify(ping, null, 2));

  if (!ping.success) {
    console.log('\n⚠️ SAP RFC Gateway is not reachable at this moment.');
    console.log('Note: If S4A server instance 09 is currently stopped or requires VPN,');
    console.log('start the S4A instance or reconnect the network and retry.');
    return;
  }

  console.log('\n[2/3] Testing BOM Source Validation (CSAP_MAT_BOM_READ)...');
  const validateRes = await rfcValidateSourceBom({
    material: 'BOLT13430',
    plant: '1000',
    bomUsage: '1'
  });
  console.log('Validation Result:', JSON.stringify(validateRes, null, 2));

  console.log('\n[3/3] Reading Material BOM Details (CSAP_MAT_BOM_READ)...');
  const readRes = await rfcReadBom({
    material: 'BOLT13430',
    plant: '1000',
    bomUsage: '1'
  });
  console.log('Read Result:', JSON.stringify(readRes, null, 2));
}

runDiagnostic().catch((err) => {
  console.error('Fatal diagnostic error:', err);
});
