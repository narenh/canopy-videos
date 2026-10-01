// Placeholder: full app coming in the next commit.
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
}).listen(process.env.PORT || 3000);
