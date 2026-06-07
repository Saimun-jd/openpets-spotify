
const regex = /^[a-z0-9.-]+(?::\d{1,5})?$/i;
console.log("127.0.0.1:", regex.test("127.0.0.1"));
console.log("localhost:", regex.test("localhost"));
console.log("127.0.0.1:8765:", regex.test("127.0.0.1:8765"));
console.log("localhost:8765:", regex.test("localhost:8765"));
