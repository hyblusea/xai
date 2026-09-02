/**
 * GPT Adapter Integration Test
 * 
 * This test uses the exact same configuration as the working test-tool.js
 * to identify what's different in the gpt-adapter implementation.
 */

import { GptAdapter } from './gpt-adapter.js';

// Exact configuration from your working gpt.ini
const TEST_CONFIG = {
  baseUrl: 'https://chatgpt.com',
  authorization: 'Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjE5MzQ0ZTY1LWJiYzktNDRkMS1hOWQwLWY5NTdiMDc5YmQwZSIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MSJdLCJjbGllbnRfaWQiOiJhcHBfWDh6WTZ2VzJwUTl0UjNkRTduSzFqTDVnSCIsImV4cCI6MTc4MTA4Mzc0MiwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS9hdXRoIjp7ImNoYXRncHRfYWNjb3VudF9pZCI6ImExNjJlN2YzLWVkZWQtNDQ4Yi1iODIxLTU5ZmFjYmYzMDk3YSIsImNoYXRncHRfYWNjb3VudF91c2VyX2lkIjoidXNlci02cHZUREE4U0VzdlZsajFsN3RlRzZaNGJfX2ExNjJlN2YzLWVkZWQtNDQ4Yi1iODIxLTU5ZmFjYmYzMDk3YSIsImNoYXRncHRfY29tcHV0ZV9yZXNpZGVuY3kiOiJub19jb25zdHJhaW50IiwiY2hhdGdwdF9wbGFuX3R5cGUiOiJmcmVlIiwiY2hhdGdwdF91c2VyX2lkIjoidXNlci02cHZUREE4U0VzdlZsajFsN3RlRzZaNGIiLCJ1c2VyX2lkIjoidXNlci02cHZUREE4U0VzdlZsajFsN3RlRzZaNGIifSwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS9wcm9maWxlIjp7ImVtYWlsIjoiaHlibHVzZWFAZ21haWwuY29tIiwiZW1haWxfdmVyaWZpZWQiOnRydWV9LCJpYXQiOjE3ODAyMTk3NDIsImlzcyI6Imh0dHBzOi8vYXV0aC5vcGVuYWkuY29tIiwianRpIjoiM2RhYjVlYzEtNGVkZi00OTA4LTk0MzgtZjQ5MWI0ZDA1ZjIwIiwibmJmIjoxNzgwMjE5NzQyLCJwd2RfYXV0aF90aW1lIjoxNzgwMjE5NzQwODIxLCJzY3AiOlsib3BlbmlkIiwiZW1haWwiLCJwcm9maWxlIiwib2ZmbGluZV9hY2Nlc3MiLCJtb2RlbC5yZXF1ZXN0IiwibW9kZWwucmVhZCIsIm9yZ2FuaXphdGlvbi5yZWFkIiwib3JnYW5pemF0aW9uLndyaXRlIl0sInNlc3Npb25faWQiOiJhdXRoc2Vzc180RUs1eEwzVzFCdzR4cDQ3M2xyeWdTZkEiLCJzbCI6dHJ1ZSwic3ViIjoiZ29vZ2xlLW9hdXRoMnwxMDI3ODU3NTYyNjU5MjA2Nzg5ODMifQ.BTtZ76DB0HmG3uJqA_FxyQ2-4eDz7ungaQXJvg53yXFHLJ9GZXPd-ouxMdQ6ALmZJmW5WMBEtsCc4WW8LeFVvX0ungwel33Ptum30CMcz37fsCyehFOM4eVsXnb-_DTNB2J2rbYxSPTOtn4E4oMtOZdZFkPy4a9iuNVsoSetHp-UC1Cd1A_tR-BwizMVcH12n10aQC10NjMZ0Eif5FrwHnfyId8plYdL1Ja7zA5Lp3r4e34CJKrKACcED4zDKXpruBomjAHeJQAbuFM7Y_mvSvJUsP_ltbz-tEoxUSNaO_aJWBAFMg5XOrJwZAS5d9HkhYi7tK-YAATbv1wqxsZP1v-yFrQninfEW1D9NRpnfEnZaoK7rom-ULSVkHqv4MJP57aWq-haQf2VW25BVVIi7BZ6bP7Zi4Svi-AMY3-VlGTqBZrO6ZeqIezPanDWqxf8sav0s4rMQZAUVSS_OEFMYX6MdITbbhM-gSEAlFYo_jGN7dnqbg1FBgoDUTtfDwMPjKcAQnCoVXOZkDLBEfwQvx8r3uTJW84beea790rBgzP6sIvLNeQmTnZulN54es90eCZi0vZX-MUsklea9kHszqOfZ7oiygdCPyBTTPn9ICTyxNWETLMhajsBoOeh3vnmdicTgfm3x3iMfPqKLnCJNcJkclgQo-AkoP6AJGg9INE',
  cookies: '__Host-next-auth.csrf-token=cb6a1ad49deec8c81b2b24c9285b466f3fd054c819c14267ffc5fd80e9efff6d%7Ca96f1d7924bba6a009c925b1e8172fb0cba8f7701e419a548bedf6b764ef7c82; oai-did=7aa5f775-c09a-495b-9957-7c13efc88b9d',
  deviceId: '7aa5f775-c09a-495b-9957-7c13efc88b9d',
  xOaiIs: 'ois1.eyJ2IjoxLCJhbGciOiJBMjU2R0NNIiwia2lkIjoiY2hhdGdwdC13ZWItdjEifQ.B--qn9oc8PRbpdHQ.tfbcvls1lrAJyeE9l-HrlfJBeOdw9AunvbEc0Do5UMNAsKxlntQE8Uj21JrgN8_aPoTTBmlS9gm-EfpI3pkSQ2aFs4KIQVhiZk_Ynp5o5cPQ5Y22lS1xOBBhV8OCjx8mzezVn0nNUBGexksXab-GDeILWs5opVKW6BsIc0U2DjJM2lMgettit9ulkFQoGK0msuD23asrEZYt2p9aWMEihiEbyYNotPW2HJ2l9TWvkR0UUl1FqnZnxibXcDgXz2yO75CBIZJjnUNI8jdN7a_bZDtY5x3Wi59Q05X9eT9zqD-x6sKXtLK_R7AYt_lDYYHsoO5cIMYXu5FgIofX8CiFcua7PgjwTAE1e7ETwHM1tj1ilOqyQyGzyTcc0TOLMr8ErLRgdK-cpj_GO_ODXPDlstMcqmO6zOcTT9IwtegCvbnnCYIlMgFnr2U1zrCg2yDEJ2zPObGc7RLTEhHPYAbjuaakGDvZXZy1HXmXiPZqlMJW_idYK58rSkmI-L33EubseJntJuHv5kkI-SYlzuOtK8yWLo7KtcRVENDhZHv1JHjtBj6XifMkHE8qq1JeEHpWiEVCFlIwETbeS40n9vyP9Rga3ahlI-3LENL8opaPR2pPEhhWHR-FkaVM6iMvgZ2ytP2D1mSiw53vf4Yrv77lNTIRjhvZLDM3zeTeSOW851opv9vsGrcNmcFBzUzPoCRh1oQHlE10AHUKdzgVabI7fF3u39Vveps9-MM5oN5J5B25p0_yK9IC3gthTB5AzfR3ozgqHEB4IePIUFXKd-E94KklQNXDxYkjdHV-xembtDLIuyTC-2B_SAAOlUEeEh3enXhdROBOE3nnvRiRTWNeZJC33qr2emfL7D9RawWw-ZiJQ5XBwviqH0RW8pFx3TLE7c6eJLjV_gCIKuaGtMDWmQhjpQrj8kbXq3ek_Ku4MShoDeCEIVQ8glIC_csGmpJXy6O5u2At4MAaUpsozHwX6WFcn7vkYTvW46jcrpXE5JTyg214aLD_gXLuNQnI8kBbj1AMSy0j52VOS9TlLY9_fd7PtzhJvtZlDMDe0tYXniwDLSAn-4b27m1bJTqk2z_6hAXZBmO5hF1g6TIkhg72DbtzWTHMK4llY5pX2wYQMrq4DM1pcwtYwGyvNXjeiIMeyXpqjuKStZcWvTeG6AuruGdCB__rfQUVTPOt2Z0Dt0B9t399lvp5yQNYBu-JLLgXLw3G8XLcF2ZxKIZR3pI5pHsIAgMKjRpZtLPoA7zHFodhIBjhGbA5-x2NFtb95gLNJNa-8nuoFkTX_UKOmgpBM7LFgEQ2iwHHlVCCRqGrTGC7apUo3eDeT80HEjUlWAGoarBFcbuYXGJLZzbpqGKYtGx_DlzPf3BoGKGEOFloRn1BtMODZ3Cz4v0prsniM7mqRxWFHYIRy0NdIOWczcwtFi_Yh0Wh0gRz2BoK_kHSBwKLILfFQdXFhmHHs6ZFUgfjqdX3nWkDuYzQbB5Ir3OGt5jnqpzEaon3sMgo5OnER0BWmqwJiI9V3bjDSzPNRDmP8V_murbcNYqbz4g',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  secChUa: '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  secChUaMobile: '?0',
  secChUaPlatform: '"Windows"',
  acceptLanguage: 'zh-CN,zh-TW;q=0.9,zh;q=0.8',
  clientBuildNumber: '7034670',
  clientVersion: 'prod-355892676443208d0eb87aeaeb17d3ef3327f23f',
  oaiLanguage: 'zh-CN',
  timezone: 'Asia/Shanghai',
  timezoneOffset: -480,
  proxyUrl: 'http://127.0.0.1:10808', // Your working proxy
};

async function testGPTAdapter() {
  console.log('=== GPT Adapter Integration Test ===\n');
  
  const adapter = new GptAdapter(TEST_CONFIG);
  
  console.log('1. Testing /conversation/prepare endpoint...');
  try {
    const request = await adapter.translateInput(
      [
        { role: 'user', content: 'Hello, this is a test message', timestamp: Date.now() }
      ],
      {
        provider: 'gpt',
        model: 'auto',
        maxTokens: 128000,
        temperature: 0.7,
      }
    );
    
    console.log('✅ translateInput succeeded');
    console.log('   URL:', request.url);
    console.log('   Method:', request.method);
    console.log('\n2. Checking request headers...');
    console.log('   Headers:', JSON.stringify(request.headers, null, 2));
    
    console.log('\n3. Now making actual fetch request...');
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    
    console.log(`   Status: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log('   Error response:', errorText.substring(0, 500));
      console.log('\n❌ Request failed - this indicates the issue');
    } else {
      console.log('\n✅ Request successful!');
      // For SSE stream, read a bit
      const reader = response.body?.getReader();
      if (reader) {
        const { value } = await reader.read();
        if (value) {
          console.log('   First chunk:', value.toString().substring(0, 200));
        }
      }
    }
  } catch (err) {
    console.error('❌ Test failed with error:', err);
  }
}

// Run the test
testGPTAdapter().catch(console.error);
