const quoteRegex = /(\w+)\s+"([^"]+)"/g;
const text1 = 'an email "test@test.com"';
const text2 = 'an age "25"';

let qMatch;
while ((qMatch = quoteRegex.exec(text1)) !== null) {
  console.log("text1 match:", qMatch[1], qMatch[2]);
}
while ((qMatch = quoteRegex.exec(text2)) !== null) {
  console.log("text2 match:", qMatch[1], qMatch[2]);
}
