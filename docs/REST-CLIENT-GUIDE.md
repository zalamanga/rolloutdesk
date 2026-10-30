# Belajar REST API RolloutDesk lewat Postman

Backend proyek ini memakai Rust dan axum. React hanya salah satu client. Kamu bisa memakai API yang sama lewat Postman tanpa membuka halaman React.

Ada 12 pasangan method dan route. Kontrak yang dapat dibaca mesin ada di [openapi.json](openapi.json). Untuk mencoba alur lengkap, gunakan [collection Postman](postman/RolloutDesk.postman_collection.json) dan [contoh environment](postman/RolloutDesk.local.postman_environment.example.json). Keduanya tidak berisi password atau token asli.

## 1. Jalankan server

Dari root repository:

```powershell
.\scripts\Start.ps1
```

Alamat server adalah `http://127.0.0.1:8098`. Nginx menerima request lalu meneruskannya ke Rust. Rust membaca atau mengubah PostgreSQL. Untuk alur ini, kamu tidak perlu memasang Rust atau PostgreSQL langsung di Windows.

Sesudah image web terbaru dibangun, berkas dokumentasi juga tersedia melalui server:

| URL | Isi |
| --- | --- |
| `http://127.0.0.1:8098/openapi.json` | Spesifikasi OpenAPI 3.0.3 untuk 12 route Rust. |
| `http://127.0.0.1:8098/postman.collection.json` | Collection dengan 16 request berurutan. |
| `http://127.0.0.1:8098/postman.environment.example.json` | Environment dengan kolom secret kosong. |

`openapi.json` adalah dokumen JSON, bukan halaman Swagger UI. Kamu dapat mengimpornya ke API client yang mendukung OpenAPI. Collection terpisah menyertakan script untuk menyimpan CSRF dan versi sehingga alur demo lebih mudah diikuti.

## 2. Import dan isi environment privat

1. Di Postman, pilih **Import** dan pilih dua berkas JSON dalam `docs/postman`.
2. Pilih environment **RolloutDesk local example (fill secrets privately)**.
3. Pertahankan `baseUrl` sebagai `http://127.0.0.1:8098` dan `operatorEmail` sebagai `operator@rolloutdesk.test`.
4. Buka `.local/LOCAL-CREDENTIALS.txt` secara lokal. Isi `operatorPassword`, `stagingToken`, dan `productionToken` pada nilai lokal/privat environment sesuai namanya. Jangan masukkan nilai itu ke berkas contoh dalam Git.
5. Pastikan cookie jar Postman aktif. Login akan menyimpan cookie `rolloutdesk_session` untuk host `127.0.0.1`. Jangan membuat cookie manual atau menyalin cookie dari browser.

Jangan membagikan environment yang sudah berisi secret, hasil ekspor session, screenshot header autentikasi, atau collection yang masih menyimpan CSRF. Collection publik selalu memulai `csrfToken` dan `expectedVersion` dalam keadaan kosong. Sesudah logout, script menghapus nilai sementara tersebut.

Periksa pilihan penyimpanan/sinkronisasi Postman milikmu sebelum memasukkan credential. Menandai variabel sebagai secret hanya mengaburkan tampilannya; kamu tetap perlu menjaga tempat penyimpanannya.

## 3. Jalankan urutannya

Gunakan Collection Runner sesuai urutan nomor, satu iterasi. Alur perubahan dibatasi ke `staging`. Request production hanya membaca keputusan.

| Nomor | Yang terjadi | Yang diperhatikan |
| --- | --- | --- |
| 01 | Cek kesehatan server dan database. | HTTP 200 dan `status: ok`. |
| 02 | Login memakai password operator. | Cookie disimpan oleh Postman; script menyimpan `csrfToken` hanya jika HTTP 200. |
| 03–04 | Baca session dan tiga flag. | Session mengembalikan CSRF yang sama. |
| 05 | Baca detail flag, `state.version`, dan history. | Script menyiapkan dua konfigurasi dengan nilai `enabled` berbeda; konfigurasi pertama berbeda dari active saat ini. |
| 06–07 | Simpan draft pertama lalu publish. | Respons save berupa `EnvironmentState`; respons publish berupa `FlagDetail`. Versi dan revision mempunyai arti berbeda. |
| 08–09 | Simpan dan publish draft kedua. | Client baru berubah sesudah publish. |
| 10 | Rollback ke publication pertama dari run ini. | Active memakai konfigurasi pertama; draft tetap konfigurasi kedua. Rollback menambah revision baru. |
| 11 | Bandingkan draft dan published untuk subject yang sama. | Bucket keduanya sama; revision draft null. Keputusannya dapat berbeda. |
| 12 | Baca audit. | Terdapat catatan save, publish dan rollback; page berukuran 25. |
| 13–14 | Evaluasi staging dan production dengan token masing-masing. | Production yang belum dipublish boleh mengembalikan `UNPUBLISHED` dengan HTTP 200. |
| 15 | Coba token staging untuk production. | HTTP 401 memang hasil yang diharapkan. |
| 16 | Logout. | HTTP 204 tanpa body; cookie diakhiri. |

Satu run lengkap menambahkan tiga publication dan mengubah satu flag staging. Simpanan konfigurasi lama tetap ada dalam history. Collection memeriksa bahwa history masih mempunyai ruang untuk tiga revision, karena batas server adalah 100 publication per flag/environment. Gunakan data lab sintetis.

Script menyimpan versi hanya dari respons HTTP 200. Script tidak mengganti versi setelah HTTP 409 dan tidak mengulangi mutation secara otomatis. Jika respons tidak sesuai, Runner menghentikan rangkaian. Ketika menekan **Send** satu per satu, berhenti sendiri jika request gagal; pengaturan next request hanya mengendalikan Runner.

## 4. Pahami satu request dari awal

Contoh save draft menggunakan method `PUT`:

```http
PUT /api/flags/checkout-redesign/staging/draft
Content-Type: application/json
Origin: http://127.0.0.1:8098
X-CSRF-Token: <csrf dari session yang sama>
Cookie: rolloutdesk_session=<dikelola cookie jar>
```

```json
{
  "expectedVersion": 1,
  "config": {
    "enabled": true,
    "rolloutBasisPoints": 2500,
    "allowlist": ["demo-alice"]
  }
}
```

Angka `1` hanya contoh untuk state baru. Pakai versi hasil GET detail atau mutation sebelumnya yang berhasil, seperti script collection. `2500` basis points berarti 25 persen. Cookie membuktikan session operator, CSRF mengikat mutation pada session itu, dan Origin harus sama persis dengan konfigurasi server.

Alur kode request tersebut:

1. `backend/src/api.rs::security` membaca session dan memeriksa Origin serta CSRF.
2. `StrictJson` memeriksa `application/json`, batas body 16 KiB, dan bentuk field melalui Serde. Field asing, integer pecahan dan JSON yang rusak mendapat HTTP 400.
3. Handler `save_draft` memanggil `Store::save_draft` dalam `backend/src/store.rs`.
4. `Config::canonical` memeriksa threshold dan allowlist, lalu mengurutkan subject. `lock_state` mengunci row flag/environment dan membandingkan versi.
5. Draft yang berubah dan audit disimpan dalam satu transaksi. Draft yang identik dapat dikembalikan tanpa menaikkan versi.
6. Rust mengirim JSON `EnvironmentState`. Collection memakai versi dari respons sukses itu untuk langkah publish berikutnya.

`POST /client/v1/evaluate/staging` memakai autentikasi lain: `Authorization: Bearer <token staging>`. Request ini tidak memerlukan cookie, CSRF, atau Origin. Ia hanya membaca active publication. Token environment tidak boleh dimasukkan ke source React atau URL.

## 5. Bedakan versi, revision dan status HTTP

`state.version` adalah token untuk mendeteksi perubahan bersamaan. `state.active.revision` adalah nomor snapshot publication. Save draft dapat menaikkan version tanpa membuat revision. Rollback membuat revision baru, bukan menurunkan nomor revision.

| Status | Tindakan saat mencoba API |
| --- | --- |
| 400 `INVALID_REQUEST` | Periksa JSON, nama field, integer, body, threshold, allowlist dan note. Backend ini memakai 400 untuk Content-Type yang salah; bukan 415/422. |
| 401 `UNAUTHORIZED` | Login ulang jika session berakhir, atau periksa token environment untuk API client. |
| 403 `FORBIDDEN` | Periksa Origin persis `http://127.0.0.1:8098` dan CSRF dari session yang sesuai. |
| 404 `NOT_FOUND` | Periksa key, environment atau target revision pada route operator. |
| 409 `VERSION_CONFLICT` | GET detail lagi, baca perubahan, lalu putuskan request baru. Jangan langsung mengganti angka dan mengulang. |
| 409 `NO_CHANGE` | Konfigurasi yang akan dipublish/dirollback sama dengan active. Tidak ada release baru yang perlu dibuat. |
| 409 `REVISION_LIMIT` | Pair tersebut sudah mencapai 100 publication. Restart tidak menghapus history. |
| 429 `RATE_LIMITED` | Tunggu window lima menit. Batas 10 percobaan login menghitung login sukses juga. |
| 500/503 | Periksa kesehatan dan log layanan tanpa menyalin secret. |

Jika koneksi terputus setelah mengirim publish, server mungkin sudah commit. Baca detail dan history untuk memastikan hasilnya sebelum mengirim mutation lain. API ini tidak menyediakan idempotency key untuk publication.

## 6. Menjaga dokumentasi sesuai source

Ketiga berkas JSON publik dihasilkan dari `scripts/generate-api-docs.mjs`. Generator tidak membaca `.env`. Setelah mengubah kontrak dan memperbarui generator:

```powershell
node scripts/generate-api-docs.mjs
node scripts/check-api-docs.mjs
```

Checker membutuhkan dependency frontend yang sudah terpasang. Ia memvalidasi OpenAPI 3.0.3, mencocokkan method/route dengan Rust, memeriksa hasil generator, model nullable dan sintaks script collection. Pemeriksaan statis itu tidak menjalankan request Postman terhadap server. Hasil tes layanan yang benar-benar dijalankan dicatat terpisah dalam [VERIFICATION.md](VERIFICATION.md).

Dengan server berjalan, `node scripts/check-served-docs.mjs` memeriksa status HTTP, Content-Type dan kesamaan isi ketiga unduhan JSON. Collection juga sudah diuji terhadap API dan PostgreSQL nyata menggunakan Newman: 16 request dan 29 assertion lulus. Newman tidak dibutuhkan untuk menjalankan aplikasi atau mengimpor collection ke Postman.
