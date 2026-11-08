const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const p = new Pool({connectionString:'postgres://tablenest_user:LE2vo4JuKXzE2iAed27HtTpb3g4glVcP@dpg-dbdp3d95pdvs73d0kmug-a.oregon-postgres.render.com/tablenest', ssl:{rejectUnauthorized:false}});
(async()=>{
  try {
    const h = bcrypt.hashSync('pass1234', 10);
    await p.query('UPDATE users SET password_hash = $1', [h]);
    const r = await p.query('SELECT email, role FROM users ORDER BY id');
    console.log(JSON.stringify(r.rows));
    await p.end();
    process.exit(0);
  } catch(e) {
    console.error(e.message);
    await p.end();
    process.exit(1);
  }
})();
