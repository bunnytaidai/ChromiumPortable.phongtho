const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'profiles.db');
console.log('DB PATH:', dbPath);
const db = new sqlite3.Database(dbPath);

db.all('SELECT * FROM scripts', [], (err, rows) => {
    if (err) {
        console.error('Lỗi truy vấn scripts:', err);
    } else {
        console.log('--- SCRIPTS ---');
        console.log(JSON.stringify(rows, null, 2));
    }
});

db.all('SELECT * FROM campaigns', [], (err, rows) => {
    if (err) {
        console.error('Lỗi truy vấn campaigns:', err);
    } else {
        console.log('--- CAMPAIGNS ---');
        console.log(JSON.stringify(rows, null, 2));
    }
    db.close();
});
