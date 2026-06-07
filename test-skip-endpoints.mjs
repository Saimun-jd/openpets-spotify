
import http from "node:http";

function testEndpoint(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:8765${path}`, (res) => {
      let body = "";
      res.on("data", d => body += d);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
  });
}

async function runTests() {
  console.log("Testing /next…");
  try {
    const next = await testEndpoint("/next");
    console.log(`/next status: ${next.status}`);
    console.log(`/next body: ${next.body}`);
  } catch (e) {
    console.error("Error with /next:", e);
  }

  console.log("\nTesting /previous…");
  try {
    const prev = await testEndpoint("/previous");
    console.log(`/previous status: ${prev.status}`);
    console.log(`/previous body: ${prev.body}`);
  } catch (e) {
    console.error("Error with /previous:", e);
  }
}

runTests().catch(console.error);
