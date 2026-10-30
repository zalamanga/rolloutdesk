# Menjelaskan RolloutDesk saat interview

RolloutDesk adalah proyek latihan untuk mengatur rilis fitur. Backend-nya memakai Rust, antarmukanya React, dan datanya PostgreSQL. Saat demo, gunakan data sintetis dan sebutkan bahwa tiga flag dan dua environment memang tetap.

## Penjelasan sekitar satu menit

> Saya membuat RolloutDesk untuk memisahkan pekerjaan mengedit konfigurasi dari keputusan yang dipakai client. Operator menyimpan draft, lalu memublikasikan snapshot yang tidak dapat diedit. Client hanya membaca revisi aktif. Setiap environment punya versi sendiri, sehingga perubahan staging tidak mengubah production.
>
> Tantangan utamanya ada pada transaksi dan konflik. Kalau dua tab mengedit versi yang sama, hanya perubahan pertama yang boleh diterima. Publish menyimpan revisi, active pointer dan audit dalam satu transaksi PostgreSQL. Rollback membuat revisi baru dari konfigurasi lama sambil mempertahankan draft. Untuk rollout persentase, saya memakai bucket SHA-256 yang stabil berdasarkan flag, environment dan subject ID, sehingga menaikkan persentase tidak mengacak kelompok yang sudah masuk.

Sesuaikan kata-katanya dengan pemahamanmu. Jika ada bagian yang masih harus dibaca, katakan bagian mana yang sedang kamu pelajari. Hindari menyatakan pernah menjalankan sistem ini untuk pelanggan atau mengelola trafik produksi jika memang belum.

## Siapkan sebelum demo

```powershell
cd "D:\kerjaan\done push repo\rolloutdesk"
.\scripts\Start.ps1
```

Buka **http://127.0.0.1:8098**. Baca kredensial lokal dari `.local/LOCAL-CREDENTIALS.txt`, lalu tutup berkas tersebut sebelum berbagi layar. Jangan menampilkan `.env` atau token client saat interview.

Normal stop mempertahankan database. Demo berikutnya mungkin sudah memiliki revisi dan audit dari demo sebelumnya. Periksa keadaan awal sebelum mulai; jangan mengatakan histori kosong jika sudah ada isinya. Setiap pasangan flag/environment memiliki batas 100 publikasi.

## Urutan demo sekitar sepuluh menit

| Langkah | Yang ditunjukkan | Penjelasan yang diberikan |
| --- | --- | --- |
| 1. Registry | Tiga flag dengan staging dan production | Masing-masing environment menyimpan draft, versi dan publikasi sendiri. |
| 2. Edit draft staging | Enabled, persentase dan allowlist | Menyimpan draft belum mengubah keputusan client. |
| 3. Playground | Perbandingan draft dan published untuk subject yang sama | Backend menjalankan fungsi evaluasi yang sama; preview tidak menyimpan subject/exposure. |
| 4. Publish | Note, state version dan revisi aktif baru | Server menerbitkan draft tersimpan dalam satu transaksi. |
| 5. Client check | Keputusan dari endpoint bearer | Token terikat environment, dan client hanya membaca published. |
| 6. Konflik dua tab | Versi lama ditolak | `expectedVersion` mencegah penimpaan pekerjaan orang/tab lain. |
| 7. Rollback | Revisi baru menyalin konfigurasi lama | Histori lama tetap utuh, source revision tercatat, draft tidak berubah. |
| 8. Audit | Actor, note, environment, revision dan waktu | Hanya perubahan yang diterima yang masuk audit; evaluasi tidak menambah catatan. |

Untuk client check, jalankan skrip ini tanpa menampilkan token:

```powershell
.\scripts\Client-Check.ps1 -Environment staging -FlagKey checkout-redesign -SubjectId demo-alice
```

Jika database masih baru, kamu bisa memakai allowlist `demo-alice` agar hasil demo mudah dijelaskan. Ketika enabled, subject itu mendapat alasan `ALLOWLIST`. Ketika disabled, ia tetap mendapat false dengan alasan `DISABLED`. Ini menunjukkan urutan aturan, bukan menebak bucket.

## Cara menjelaskan file dan alur request

Mulai dari kebutuhan, lalu tunjukkan jalurnya:

```text
klik Publish
  -> FlagPage.tsx mengirim expectedVersion + note
  -> api.ts menyertakan cookie dan token CSRF
  -> Nginx meneruskan /api ke Rust
  -> api.rs memvalidasi request dan session
  -> store.rs mengunci state dan menjalankan transaksi
  -> PostgreSQL menyimpan revision + active pointer + audit
  -> respons detail baru memperbarui tampilan
```

Di backend, `types.rs` mendefinisikan bentuk data, `evaluation.rs` berisi aturan bucket/keputusan, `auth.rs` menangani session/login, dan `store.rs` menangani SQL. `main.rs` merangkai konfigurasi, koneksi dan server. [CODE-GUIDE.md](CODE-GUIDE.md) membahas tiap file lebih rinci.

## Pertanyaan yang mungkin muncul

**Kenapa memilih Rust?**

Proyek ini memberi tempat untuk mempelajari backend dengan ownership, tipe data yang ketat dan error `Result`. Axum/Tokio menangani HTTP secara async. Saya tetap membatasi pekerjaan bcrypt yang memakai CPU agar tidak memblokir thread async. Pilihan Rust tidak membuat aturan bisnis otomatis benar; saya mengujinya lewat unit test dan transaksi PostgreSQL sungguhan.

**Apa arti ownership dan borrowing di proyek ini?**

Nilai Rust memiliki pemilik. Fungsi yang hanya membaca konfigurasi bisa menerima `&Config`, sehingga tidak perlu mengambil kepemilikan atau menyalin seluruh objek. Shared state seperti connection pool bisa dibagikan melalui tipe yang mendukung penggunaan lintas task. Untuk request async, data yang dipakai setelah `await` harus tetap valid sesuai lifetime-nya. Compiler membantu memeriksa penggunaan memori, sedangkan transaksi memeriksa perubahan data antarrequest.

**Kenapa memakai `Result`?**

Request dapat gagal karena input, session, konflik atau database. `Result<T, E>` memaksa fungsi menjelaskan jalur berhasil dan gagal. Operator `?` meneruskan error ke pemanggil. Di batas HTTP, error diubah menjadi status dan pesan aman; detail internal tidak perlu dikirim ke pengguna.

**Apa beda state version dengan revision?**

State version melindungi semua perubahan pada satu pasangan flag/environment. Menyimpan draft yang berubah dapat menaikkannya. Revision hanya dibuat saat publish atau rollback. Karena itu nomor version dan revision tidak harus sama.

**Kenapa perlu row lock jika sudah ada expectedVersion?**

Versi memberi tahu apakah request berasal dari data lama. Row lock membuat pemeriksaan versi dan perubahan berikutnya berjalan sebagai satu urutan untuk pasangan yang sama. Tanpa pemeriksaan yang terlindungi, dua request bisa membaca versi lama yang sama sebelum keduanya menulis. PostgreSQL menahan lock sampai transaksi selesai.

**Apa yang terjadi kalau server error setelah revision dimasukkan?**

Insert revision masih berada dalam transaksi yang sama dengan active pointer dan audit. Jika transaksi gagal sebelum commit, PostgreSQL membatalkan seluruh perubahan. Pengujian memakai kegagalan terkontrol setelah insert revision untuk memeriksa sifat itu. Hasil run yang benar-benar dilakukan dicatat di [VERIFICATION.md](VERIFICATION.md).

**Kenapa rollback menambah revision?**

Rollback adalah keputusan rilis baru. Dengan menambah record, kita dapat melihat kapan operator kembali ke konfigurasi lama dan dari revision mana ia menyalinnya. Mengubah histori lama akan menghilangkan bukti tersebut. Draft tetap dipertahankan karena pekerjaan yang belum dirilis tidak seharusnya hilang saat rollback.

**Bagaimana mencegah client membaca setengah perubahan?**

Active pointer, revision dan audit berubah atomik dalam satu transaksi. Read yang merangkai state dan history memakai snapshot yang konsisten. Client mendapatkan satu konfigurasi published, bukan campuran state yang dibaca di waktu berbeda.

**Bagaimana cara kerja rollout 25%?**

Server menghitung bucket 0 sampai 9.999 dari SHA-256 flag, environment dan subject. Jika enabled dan bucket lebih kecil dari 2.500, keputusan true. Allowlist diperiksa terlebih dahulu setelah enabled. Bucket tidak memuat revision atau persentase, sehingga menaikkan threshold mempertahankan kelompok sebelumnya.

**Apakah 25 dari 100 subject pasti mendapat true?**

Tidak. Threshold membagi ruang bucket, sementara jumlah subject yang terbatas bisa menghasilkan proporsi berbeda. Proyek ini tidak mengklaim pembagian tepat untuk setiap sampel dan tidak menghitung signifikansi eksperimen.

**Apakah feature flag dapat dipakai sebagai izin admin?**

Tidak. Flag mengendalikan perilaku fitur sintetis. Backend bisnis tetap harus memeriksa autentikasi dan izin akses sendiri. Subject ID dalam demo bukan identitas yang telah diverifikasi.

**Kenapa ada endpoint preview dan client yang terpisah?**

Operator perlu membandingkan draft dengan published melalui session dan CSRF. Client hanya perlu keputusan published memakai token environment. Token client tidak masuk browser, tidak dapat melihat draft dan tidak dapat memublikasikan perubahan.

**Apa yang dilakukan UI jika respons publish hilang?**

UI menganggap hasilnya belum pasti dan menahan mutation berikutnya sampai refresh eksplisit. Server mungkin sudah commit. Setelah membaca ulang versi dan active revision, pengguna memutuskan apakah masih perlu mengirim perubahan. UI tidak otomatis mengambil versi baru dan mengulangi publish.

**Apa batas proyek ini?**

Registry tetap, satu operator, dua environment dan batas 100 publikasi per pasangan. Belum ada multi-tenancy, roles, SDK streaming, exposure analytics, rotasi token melalui UI atau prosedur high availability. Docker lokal memudahkan demo, tetapi belum membuktikan kesiapan produksi.

## Jika diminta melanjutkan pengembangan

Mulai dari kebutuhan perusahaan. Misalnya, beberapa tim memerlukan role dan tenant isolation sebelum jumlah flag ditambah. Tim operasional mungkin membutuhkan backup/restore teruji, rotasi token, TLS dan pemantauan. Client dengan trafik besar mungkin memerlukan cache dan protokol pembaruan yang jelas. Jelaskan risiko dan pengujiannya sebelum menambahkan teknologi baru.

Saat interview selesai, hentikan stack milik proyek ini:

```powershell
.\scripts\Stop.ps1
```
