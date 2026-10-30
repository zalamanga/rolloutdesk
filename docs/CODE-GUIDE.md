# Membuat dan memahami RolloutDesk dari nol

Panduan ini menjelaskan urutan membangun ulang proyek serta alasan tiap bagian kode. Gunakan source dalam repository sebagai versi lengkap yang dapat dijalankan. Potongan singkat di bawah menjelaskan kontrak dan alur, sehingga kamu tidak perlu menyalin seluruh aplikasi sekaligus.

RolloutDesk memisahkan draft dengan konfigurasi yang sudah dirilis. Operator mengedit melalui React. Rust memvalidasi request, menyimpan perubahan di PostgreSQL, dan menghitung keputusan flag. Docker menjalankan komponen tersebut dengan Nginx sebagai pintu masuk.

Untuk mempelajari backend tanpa React, mulai dari [tutorial REST dan Postman](REST-CLIENT-GUIDE.md). `docs/openapi.json` menjelaskan 12 route Rust dalam OpenAPI 3.0.3. `scripts/generate-api-docs.mjs` menghasilkan kontrak tersebut beserta collection dan contoh environment tanpa membaca secret. `scripts/check-api-docs.mjs` memvalidasi kontrak dan mencocokkan route dengan `backend/src/api.rs`. Nginx menyajikan dokumen publik itu sebagai JSON terpisah dari halaman React.

## 1. Tetapkan perilaku sebelum membuat halaman

Ada tiga flag tetap: `checkout-redesign`, `bulk-export`, dan `priority-support`. Masing-masing mempunyai `staging` dan `production`. Keadaan awal adalah draft disabled, persentase nol, allowlist kosong, version 1, dan belum ada publication.

Tulis aturan berikut sebelum membuat endpoint:

- Mengedit draft tidak mengubah keputusan client.
- Publish membuat snapshot immutable dari draft yang sudah tersimpan.
- Rollback membuat snapshot baru dari revision lama, sambil mempertahankan draft.
- Setiap perubahan memeriksa `expectedVersion` untuk mencegah penimpaan data lama.
- Keputusan client hanya membaca active publication untuk environment yang diminta.
- Preview menghitung keputusan tanpa menyimpan subject atau exposure.

Aturan ini menjelaskan mengapa aplikasi memerlukan lebih dari satu tabel dan lebih dari satu angka versi. [CONTRACT.md](CONTRACT.md) mencatat bentuk request/response yang dipakai backend dan frontend.

## 2. Siapkan folder dan runtime

```text
rolloutdesk/
  backend/              Rust API, SQL dan tes
  frontend/             React, TypeScript dan tes browser
  scripts/              Perintah PowerShell untuk operasi lokal
  docs/                 Panduan dan screenshot
  compose.yml           Stack aplikasi
  compose.test.yml      Database tes terpisah
  .env.example          Nama konfigurasi tanpa secret
```

Untuk mempelajari versi jadi:

```powershell
.\scripts\Init.ps1
.\scripts\Start.ps1
```

Siapkan PowerShell, Docker Desktop dengan Linux containers, dan Node.js 22 beserta npm. Node menjalankan helper konfigurasi privat serta pemeriksaan frontend lokal. Docker mengambil toolchain Rust dan membangun aplikasi di Linux, sehingga kamu tidak perlu memasang compiler C++ Windows untuk jalur ini. Setelah server siap, buka **http://127.0.0.1:8098** dan gunakan kredensial di `.local/LOCAL-CREDENTIALS.txt`.

Jika membangun dari folder kosong, buat kontrak, schema dan evaluator dahulu, lalu request HTTP, kemudian UI. Urutan tersebut membuat aturan penting dapat diuji sebelum bentuk halaman selesai.

## 3. Bentuk data Rust

`backend/src/types.rs` mendefinisikan request dan response bertipe. Bentuk konfigurasi dalam JSON adalah:

```json
{"enabled":true,"rolloutBasisPoints":2500,"allowlist":["demo-alice"]}
```

Rust memakai boolean untuk `enabled`, integer untuk basis points, dan daftar string untuk allowlist. Serde menerjemahkan nama field ke camelCase. Request yang tidak sesuai tipe atau memiliki field tak dikenal ditolak, bukan ditebak atau diperbaiki diam-diam.

Bagian inti tipe tersebut di source:

```rust
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    pub rollout_basis_points: u16,
    pub allowlist: Vec<String>,
}
```

`Deserialize` membaca JSON masuk, `Serialize` menghasilkan JSON keluar. `PartialEq`/`Eq` memungkinkan server membandingkan konfigurasi untuk menolak no-op. `u16` menolak angka negatif atau pecahan, sedangkan `Config::canonical()` menambahkan batas bisnis maksimal 10000, validasi subject, sorting dan penolakan duplikat.

Pemisahan tipe memberi nama yang berbeda kepada `EnvironmentState`, `Publication`, `Decision` dan respons preview. Dengan begitu, kode yang memerlukan snapshot publikasi tidak menerima draft tanpa sengaja.

Persentase menggunakan integer basis points. `25.00%` menjadi `2500`; `0.01%` menjadi `1`. UI membaca teks dan mengonversi angka desimal secara tepat. Jangan memakai hasil pembulatan floating point untuk mengubah input seperti `12.345%` menjadi nilai yang tampak valid. Input itu memang harus ditolak karena melebihi dua angka desimal.

## 4. Bangun evaluator sebagai fungsi murni

`backend/src/evaluation.rs` berisi validasi subject, perhitungan bucket dan urutan keputusan. Fungsi murni menerima data dan menghasilkan nilai tanpa koneksi database, session atau perubahan global. Karena itu tes dapat memeriksa input yang sama berulang kali tanpa menyiapkan server.

Urutan keputusannya:

```text
enabled = false                         -> false, DISABLED
enabled dan subject ada di allowlist     -> true, ALLOWLIST
enabled dan bucket < rolloutBasisPoints  -> true, ROLLOUT
selain itu                              -> false, OUTSIDE_ROLLOUT
```

Allowlist tidak mengalahkan disabled. Ini membuat tombol disable menjadi penghentian untuk seluruh konfigurasi, termasuk subject yang sebelumnya diprioritaskan.

Input hash memiliki domain `rolloutdesk:v1`, lalu flag key, environment dan subject ID dengan prefix panjang masing-masing sebagai empat byte big-endian. Prefix panjang mencegah susunan field berbeda mempunyai input gabungan yang sama hanya karena batas teksnya ambigu. Setelah SHA-256, empat byte pertama dibaca sebagai unsigned integer dan dimodulo 10000.

Fungsi `bucket()` di file ini dapat dipelajari secara utuh:

```rust
pub fn bucket(flag_key: &str, environment: &str, subject: &str) -> u32 {
    let mut hash = Sha256::new();
    hash.update(b"rolloutdesk:v1");
    for field in [flag_key, environment, subject] {
        hash.update((field.len() as u32).to_be_bytes());
        hash.update(field.as_bytes());
    }
    let digest = hash.finalize();
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 10000
}
```

`&str` meminjam teks. `to_be_bytes()` menyatakan urutan byte secara eksplisit agar implementasi lain tidak memakai endianness mesin secara tidak sengaja. `evaluate()` memanggil perhitungan ini lalu memilih reason sesuai urutan aturan; `validate_subject()` memeriksa input sebelum jalur API/penyimpanan mengevaluasinya.

Revision tidak dimasukkan ke hash. Jika revision ikut dihitung, publish ulang dapat memindahkan subject ke kelompok lain walaupun tujuannya hanya menaikkan persentase. Threshold juga tidak dimasukkan: ia dibandingkan dengan bucket setelah bucket selesai dihitung.

Tes bagian ini perlu mencakup vektor hash dengan nilai yang sudah ditetapkan, threshold 0 dan 10000, batas bucket, disabled versus allowlist, serta sifat cohort saat threshold meningkat. Hasil tes aktual berada di [VERIFICATION.md](VERIFICATION.md).

## 5. Buat schema sebelum fungsi database

`backend/migrations/001_init.sql` mendefinisikan penyimpanan untuk operator/session, registry/state, publication dan audit, beserta constraint yang menjaga hubungan datanya. Baca file ini sebelum `store.rs` agar nama kolom dan foreign key punya konteks.

Satu baris state mewakili satu pasangan flag/environment. State menyimpan draft dan referensi active publication. Tabel publication menyimpan salinan konfigurasi, bukan hanya pointer ke draft yang bisa diedit. Jika publication membaca draft secara langsung, perubahan draft berikutnya akan mengubah arti histori lama.

Migration berjalan melalui startup backend. Seed menambahkan registry dan state yang belum ada. Operator hanya dibuat ketika tabel user kosong. Startup bukan perintah untuk mengubah password user yang sudah tersimpan.

Schema juga membuat trigger `publication_immutable` yang menolak `UPDATE` dan `DELETE` pada publication. Constraint pasangan flag/environment/revision membuat active pointer dan source revision menunjuk histori dari pasangan yang sama. Perlindungan ini melengkapi aturan di Rust; tidak hanya mengandalkan tombol UI yang disembunyikan.

## 6. Pisahkan operasi database dari HTTP

`backend/src/store.rs` berisi migrasi, seed, SQL read dan transaksi perubahan. Handler HTTP tidak menyusun ulang semua aturan SQL. Pemisahan ini membantu tes menjalankan operasi penyimpanan langsung untuk konflik dan kegagalan transaksi.

Saat menyimpan draft, server mengunci state, membandingkan `expectedVersion`, memvalidasi konfigurasi, lalu menyimpan konfigurasi baru dan audit. Draft identik dapat mengembalikan state yang sama. Saat publish, server harus memakai draft yang sudah ada di database, bukan konfigurasi tambahan dari request publish.

Gambaran transaksi publish:

```text
BEGIN
  SELECT state FOR UPDATE
  periksa expectedVersion
  periksa kapasitas 100 publication dan perbedaan config
  INSERT publication dari draft tersimpan
  UPDATE active pointer dan version
  INSERT audit
COMMIT
```

Ini adalah urutan konseptual; lihat fungsi di `store.rs` untuk SQL lengkap. Row lock tetap aktif sampai commit atau rollback. Dua request pada state yang sama akan diperiksa secara berurutan. Environment lain memiliki state/version sendiri.

Helper `lock_state()` melakukan query berparameter, lalu memeriksa versi yang dikirim:

```rust
let row = client.query_opt(
    "SELECT version,draft,active_revision FROM flag_states \
     WHERE flag_key=$1 AND environment=$2 FOR UPDATE",
    &[&key, &environment],
).await?.ok_or_else(AppError::not_found)?;

if row.get::<_, i64>("version") != expected {
    return Err(AppError::conflict(
        "VERSION_CONFLICT",
        "State changed. Refresh and review the current version before trying again.",
    ));
}
```

`$1` dan `$2` adalah parameter SQL, bukan hasil penggabungan teks input. `query_opt()` mengembalikan baris opsional; `ok_or_else()` mengubah ketiadaan baris menjadi error domain. `?` meneruskan error database. Karena caller memberikan transaction sebagai client, `FOR UPDATE` melindungi urutan sampai caller commit.

`Store::publish()` dan `Store::rollback()` masuk ke helper `revise()`. Parameter `source: Option<i32>` membedakan publish draft (`None`) dari penyalinan revision lama (`Some(revision)`). Setelah insert publication, source menjalankan update pointer dan audit sebelum `tx.commit().await?`. Parameter internal kegagalan tes tidak diterima dari request HTTP.

Jika insert publication berhasil tetapi update berikutnya gagal, transaksi tidak boleh meninggalkan publication setengah jadi. Tes database menyuntikkan kegagalan setelah insert untuk memeriksa bahwa revision, pointer dan audit semuanya dibatalkan.

Rollback menggunakan transaksi yang sama, tetapi sumber konfigurasinya adalah publication lama dalam flag/environment tersebut. Ia membuat revision baru dengan `sourceRevision`, mengubah pointer, menulis audit, dan tidak menimpa draft.

Read detail juga perlu konsisten. Jika beberapa query dibutuhkan untuk state, publication aktif dan history, gunakan snapshot repeatable-read. Tanpa itu, request read yang bertemu publish serentak dapat menyusun respons dari dua waktu berbeda.

## 7. Tangani konfigurasi dan autentikasi

`backend/src/config.rs` membaca environment dan memvalidasi panjang password, origin, pilihan secure cookie serta format digest token. `Store::connect()` kemudian membaca format URL PostgreSQL. Kegagalan konfigurasi menghentikan startup dengan kategori error yang aman, sehingga server tidak diam-diam memakai password kosong.

`backend/src/auth.rs` menangani password, session, CSRF dan batas percobaan login. Password memakai bcrypt cost 12. Bcrypt merupakan pekerjaan CPU, sehingga jalankan verifikasi di pekerjaan blocking yang dibatasi concurrency-nya, bukan langsung di async reactor.

Saat login berhasil, server menghasilkan token session acak. Browser menerima token melalui cookie HttpOnly; database menyimpan SHA-256 digest-nya. Cookie memakai SameSite=Lax dan masa berlaku 12 jam. CSRF token dikembalikan dalam respons session dan dikirim UI pada request yang memerlukannya.

Ikuti fungsi di `auth.rs` untuk memahami umur session:

1. `login()` memeriksa batas percobaan dan password, membuat session serta token CSRF, lalu mengembalikan cookie. Saat jumlah session operator mencapai 20, login berikutnya menghapus session paling lama sebelum menambah yang baru.
2. `session()` membaca cookie, menghitung digest, lalu mencari session yang belum kedaluwarsa beserta operatornya. Server memanggilnya untuk setiap request operator yang dilindungi.
3. `require_csrf()` memeriksa Origin dan token CSRF pada mutation serta preview. Membaca cookie saja belum memenuhi syarat untuk mengubah data.
4. `logout()` menghapus baris session dan mengirim cookie dengan masa berlaku nol. Session lain tetap tersimpan sampai kedaluwarsa atau terhapus oleh batas jumlah session.

`throttle()` memakai tabel PostgreSQL, sehingga restart API tidak menghapus hitungan login. Batasnya 10 percobaan per lima menit, termasuk login berhasil. Dalam Compose lokal, semua browser melewati Nginx dan berbagi satu alamat peer di API; batas ini bukan batas per pengguna.

Pemeriksaan Origin mengharuskan `http://127.0.0.1:8098`. Karena itu halaman yang dibuka lewat `localhost:8098` bukan origin yang sama. Cookie local memakai Secure=false karena demo berjalan melalui HTTP loopback. Hosting publik memerlukan konfigurasi TLS tersendiri.

Client API mempunyai token berbeda dari session operator. Dua token privat masing-masing terikat staging dan production. Skrip mengirim digest token ke konfigurasi API. Ketika request datang, backend melakukan hash terhadap bearer token dan membandingkan digest secara constant-time. Token tidak diberikan kepada React dan tidak boleh ditempel sebagai query parameter URL.

## 8. Rangkai endpoint axum

`backend/src/api.rs` memasang router, ekstraksi JSON yang ketat, pemeriksaan autentikasi dan pemetaan error menjadi respons HTTP. Endpoint operator berada di `/api`; endpoint client adalah `/client/v1/evaluate/{environment}`.

Handler publish hanya memerlukan `expectedVersion` dan `note`, karena sumber konfigurasinya sudah tersimpan. Handler preview menerima subject dan menghitung draft/published dari data server. Handler client hanya membaca publication aktif dan memerlukan bearer token environment.

`backend/src/lib.rs` mengekspos komponen library untuk binary dan tes. `backend/src/main.rs` membaca konfigurasi, membuat pool, menjalankan migration/seed dan mulai mendengarkan request. Subcommand health dipakai container healthcheck agar readiness memeriksa service yang benar.

`backend/src/error.rs` mendefinisikan `AppError` dan alias `Result<T>`. Implementasi `IntoResponse` mengubah error menjadi JSON `{code,message}` beserta status. Error driver database tidak dibagikan langsung ke browser: konversi `From<tokio_postgres::Error>` menghasilkan error internal aman, sedangkan kegagalan pool menjadi kategori unavailable.

## 9. Pahami Rust yang dipakai di backend

### Ownership dan borrowing

Nilai memiliki pemilik yang menentukan masa hidupnya. Parameter `&Config` meminjam konfigurasi untuk dibaca tanpa memindahkan kepemilikan. `&mut` memberi akses perubahan eksklusif. Ini membantu compiler menolak pemakaian nilai yang sudah dipindahkan atau referensi yang tidak lagi valid.

Pool database merupakan shared handle yang dapat dipakai banyak request. Menyalin handle pool tidak berarti menyalin seluruh database atau membuka pool baru untuk setiap request. Connection/transaction yang diperoleh dari pool memiliki batas penggunaan dan harus selesai sebelum hasil keluar dari transaksi.

### `Result` dan operator `?`

Fungsi yang bisa gagal mengembalikan `Result<T, E>`. `Ok` membawa nilai berhasil; `Err` membawa error. `?` mengambil nilai berhasil atau meneruskan error ke pemanggil. Di batas API, error domain dipetakan menjadi 400, 401, 403, 404, 409 atau error internal aman. Jangan mengirim detail SQL atau secret kepada browser hanya karena error itu tersedia di server.

### `async` dan `.await`

`async fn` menghasilkan pekerjaan yang dapat ditunda ketika menunggu I/O. `.await` memberi kesempatan runtime menjalankan task lain selama database atau socket belum siap. Ini tidak membuat CPU-bound bcrypt menjadi ringan. Bagian CPU memerlukan batas concurrency dan jalur blocking terpisah.

### Transaction bukan pengganti ownership

Ownership melindungi penggunaan memori di dalam proses. Transaction dan lock melindungi perubahan data antarrequest atau antarproses. Program Rust yang lolos compiler masih dapat memiliki lost update atau salah aturan bisnis jika transaksi dan pengecekan versinya keliru.

## 10. Bangun React setelah API dapat dibaca

`frontend/src/main.tsx` memasang aplikasi ke root DOM dan memuat stylesheet. `App.tsx` menangani session, navigasi hash, status login dan editor yang disimpan di memori tab. Halaman tidak perlu server-side rendering karena seluruh data kerja berasal dari API lokal.

`frontend/src/types.ts` menyatakan bentuk JSON yang diterima UI. `api.ts` menjadi satu tempat untuk request, cookie, CSRF, error dan respons session. Request error tidak boleh dicatat bersama password atau bearer token.

`utils.ts` menangani pekerjaan murni seperti parsing persentase, validasi daftar subject dan pembacaan route. Fungsi seperti ini tepat diuji tanpa browser. `components.tsx` menyediakan elemen kerja yang dipakai berulang, termasuk feedback dan kontrol yang mempunyai label.

`parsePercentage()` membagi teks menjadi bagian integer dan desimal, lalu menghitung basis points:

```typescript
const [whole, decimals = ""] = text.split(".");
const value = Number(whole) * 100 + Number(decimals.padEnd(2, "0"));
```

Regex memeriksa format terlebih dahulu, sehingga hanya nol sampai dua digit desimal yang diterima. Karena komponen yang dihitung integer, `12.34` menjadi `1234` tanpa membulatkan hasil perkalian floating point. `parseAllowlist()` memeriksa satu subject per baris, menolak baris kosong/spasi/duplikat dan mengurutkan hasil. `editorConfig()` menyatukan kedua hasil menjadi konfigurasi request.

| File halaman | Tanggung jawab |
| --- | --- |
| `RegistryPage.tsx` | Menampilkan tiga flag dan state dua environment dari server. |
| `FlagPage.tsx` | Editor draft, active revision, publish, rollback dan history. |
| `PlaygroundPage.tsx` | Meminta dan menampilkan perbandingan keputusan backend. |
| `AuditPage.tsx` | Membaca audit dengan pagination dan urutan server. |
| `styles.css` | Hierarki draft/published, fokus keyboard dan susunan layar sempit. |

UI tidak melakukan polling. Refresh eksplisit membaca state tanpa membuang edit dan note. Jika request mutation mendapat 409 atau hasil jaringan tidak pasti, UI menahan aksi berikutnya sampai refresh. Menyimpan form di memori tab membantu pengguna tidak kehilangan pekerjaan ketika session kedaluwarsa, tanpa menulis token/password ke localStorage.

`App.tsx` menyimpan editor dalam `Map<string, Editor>` dan lock rekonsiliasi dalam `Set<string>`, keduanya melalui `useRef`. Kuncinya pasangan flag/environment. Nilai ini tetap tersedia selama tab/aplikasi React yang sama hidup, termasuk ketika UI kembali ke login; reload penuh halaman tidak menjadi mekanisme penyimpanan permanen.

## 11. Tangani respons yang tidak pasti

Bayangkan server sudah commit publish, lalu koneksi terputus sebelum browser menerima respons. Menampilkan pesan pasti “publish gagal” akan menyesatkan. Mengambil version terbaru dan mengulang otomatis juga bisa menerbitkan perubahan yang tidak dimaksud pengguna.

Alurnya adalah menampilkan hasil belum pasti, mempertahankan input/note, menahan mutation, lalu meminta refresh eksplisit. Setelah state dan history terbaru terlihat, pengguna dapat menilai hasilnya. Server tetap memeriksa version dan menolak publication dengan konfigurasi yang sama sebagai active.

Pola ini berbeda dari idempotency key. Proyek ini tidak menyediakan key publication yang dapat diputar ulang. Jelaskan batas tersebut saat interview.

## 12. Susun container dan reverse proxy

`backend/Dockerfile` membangun executable Rust dalam builder lalu memasukkannya ke runtime image. `frontend/Dockerfile` membangun aset Vite dan menyajikannya melalui Nginx. Berkas Nginx meneruskan `/api` dan `/client` ke backend, sementara route hash diproses di browser.

`compose.yml` menghubungkan API, web dan PostgreSQL. Hanya web 8098 dan PostgreSQL 5450 yang dipublikasikan ke loopback host. Database menggunakan volume agar stop/restart tidak menghapus histori. `compose.test.yml` menyediakan PostgreSQL tes terpisah pada 5451.

Skrip lokal mengelola konfigurasi, build, start, stop dan tes. Mereka membaca `.env` sebagai data; jangan menjalankan isi file environment sebagai PowerShell. Jangan menggunakan environment aplikasi untuk tes yang mereset data.

## 13. Verifikasi dari bagian kecil ke alur nyata

```powershell
.\scripts\Test.ps1
# Setelah server aplikasi menyala:
.\scripts\Test.ps1 -WithBrowser
```

`backend/src/tests.rs` memeriksa fungsi murni dan PostgreSQL sungguhan. `frontend/src/utils.test.ts` dan `api.test.ts` memeriksa perilaku yang tidak memerlukan halaman. `frontend/tests/workflow.spec.ts` menjalankan workflow terhadap stack nyata melalui Playwright.

Kasus yang bernilai mencakup bucket stabil, validasi integer/subject, konflik dua request, rollback atomik saat insert revision sudah terjadi, token environment, draft yang belum published, rollback yang menjaga draft, serta UI yang menahan mutation setelah konflik atau hasil tidak pasti. Menyatakan tes lulus memerlukan hasil run; lihat [VERIFICATION.md](VERIFICATION.md) untuk bukti proyek ini.

## 14. Baca source dengan urutan ini

1. `docs/CONTRACT.md`: pahami aturan dan JSON sebelum membuka fungsi.
2. `backend/src/types.rs` lalu `evaluation.rs`: baca tipe dan keputusan murni.
3. `backend/migrations/001_init.sql` lalu `store.rs`: cocokkan state, revision dan transaksi.
4. `auth.rs`, `config.rs`, `api.rs`, `main.rs`: ikuti jalur HTTP dan startup.
5. `frontend/src/api.ts`, `App.tsx`, `FlagPage.tsx`: ikuti klik sampai request dan rekonsiliasi.
6. Tes backend/browser: lihat kondisi yang sengaja dibuat gagal dan hasil yang diharapkan.

Setelah urutan ini, jelaskan satu workflow dengan bahasamu sendiri: dari klik Save draft sampai data tersimpan, lalu dari Publish sampai client memperoleh keputusan. Jika kamu dapat membedakan draft, version, revision dan bucket tanpa membaca teks, fondasi proyeknya sudah lebih mudah dipahami.

## 15. Referensi fungsi dan berkas pendukung

| Lokasi | Fungsi/isi yang dicari | Perannya |
| --- | --- | --- |
| `backend/src/config.rs` | `Settings::from_env()`, `decode_digest()` | Membaca konfigurasi serta memvalidasi origin, password dan dua digest token yang harus berbeda. Format URL PostgreSQL diperiksa di `Store::connect()`. |
| `backend/src/types.rs` | `Config::canonical()`, `validate_note()`, `validate_version()` | Menetapkan bentuk input serta batas domain setelah JSON terbaca. |
| `backend/src/evaluation.rs` | `validate_subject()`, `bucket()`, `evaluate()` | Menjaga format subject dan menghitung keputusan deterministik tanpa I/O. |
| `backend/src/store.rs` | `Store::connect()`, `migrate()`, `seed()` | Membuat pool maksimal delapan koneksi, mengunci migration/seed dengan advisory lock, dan mempertahankan data lama. |
| `backend/src/store.rs` | `flags()`, `detail()`, `audit()` | Membaca beberapa query dalam snapshot repeatable-read; audit 25 baris per halaman. |
| `backend/src/store.rs` | `save_draft()`, `publish()`, `rollback()`, `revise()` | Perubahan state/version/audit serta publication atomik. |
| `backend/src/store.rs` | `client_decision()`, `preview()` | Memisahkan evaluasi active untuk client dari perbandingan draft/published operator. |
| `backend/src/auth.rs` | `AppState::initialize()`, `login()`, `session()`, `logout()` | Startup auth, bcrypt, opaque session dan invalidasi session. |
| `backend/src/auth.rs` | `require_origin()`, `require_csrf()`, `require_client()` | Menjaga batas origin/session dan bearer token environment. |
| `backend/src/api.rs` | `router()`, `StrictJson`, `decode_json()`, `parse_page()` | Merangkai endpoint serta menolak JSON/query yang tidak memenuhi kontrak. |
| `backend/Cargo.toml` | Dependencies dan profile build | Pin crate, binary `api`, compiler profile tanpa debug/LTO untuk build lab. |
| `backend/Cargo.lock` | Resolusi dependency lengkap | Menetapkan versi transitif agar build tidak memilih versi baru tanpa perubahan lock. |
| `frontend/src/api.ts` | `Api.request()`, `ApiError`, `requiresReconciliation()` | Cookie/CSRF, timeout request, error dan keputusan apakah UI perlu refresh. |
| `frontend/src/utils.ts` | `newEditor()`, `sameConfig()`, `noteError()`, `parseRoute()` | Membentuk editor, membandingkan draft, memeriksa note dan hash route. |
| `frontend/package.json` dan lock | `test`, `build`, `test:e2e` | Menjalankan unit test, TypeScript/Vite dan Playwright dengan dependency terkunci. |
| `scripts/init-env.mjs` | Inisialisasi `.env` lokal | Menghasilkan secret random dan digest token tanpa memasukkannya ke repository. |
| `scripts/Common.ps1` | `Get-RolloutEnvironment()`, `Invoke-RolloutDocker` | Membaca konfigurasi sebagai data dan memeriksa exit code Docker. |
| `scripts/Client-Check.ps1` | `Environment`, `FlagKey`, `SubjectId` | Memanggil API published dengan token privat yang sesuai environment. |
| `scripts/Start.ps1`, `Stop.ps1` | Build dan lifecycle stack `rolloutdesk` | Menyalakan layanan milik proyek dan menghentikannya sambil mempertahankan volume database. |
| `scripts/Test.ps1` | `-WithBrowser` | Menjalankan harness Rust di database tes terpisah, unit/build frontend, lalu browser terhadap stack aplikasi bila diminta. |
| `scripts/client-probe.mjs` | Probe bearer dan bucket | Membandingkan respons endpoint sungguhan dengan vektor hash independen, tanpa mencetak token. |
| `.github/workflows/verify.yml` | Workflow verifikasi | Membangun container dan menjalankan tes pada konfigurasi CI sintetis yang terpisah dari database lokal. |

Untuk request client, `client_decision()` membaca active pointer dan config dengan satu query `LEFT JOIN`. Ini menjaga konsistensi keputusan tanpa mengunduh seluruh history. Untuk preview, `preview()` memanggil detail snapshot lalu memakai `evaluate()` dua kali. Kedua jalur berbagi evaluator yang sama, sehingga tidak ada rumus persentase kedua di JavaScript.
