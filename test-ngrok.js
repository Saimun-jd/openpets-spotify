
import https from 'node:https';

const url = 'https://6b36-103-132-185-215.ngrok-free.app/now-playing';

const req = https.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', data);
  });
});
req.on('error', (e) => console.error('Error:', e));
