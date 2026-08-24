# Rencana Evolusi Harness v2 — dari "menyimpan fakta" ke "berevolusi cara bertindak"

Grounding: Continual Harness (arXiv 2605.09998 §3.2/§4.6) + ACE (arXiv 2510.04618).
Status kerja: repo bersih di `4bb92c0`, 206/206 test hijau, full-auto aktif di mesin user.

## Tujuan

Mengubah harness dari penyimpan *fakta pasif* menjadi **playbook aturan keputusan
yang terseleksi secara evolusioner** — tiap siklus refine menambah heuristik
proses teruji, item rusak disembuhkan dengan trial baru yang adil, dan store
menjaga dirinya sendiri sehat tanpa intervensi manual.

## Tier 1 — Perbaiki fondasi loop evolusi

- [x] **T1.1 Heuristik proses di prompt refine**
      File: `src/proposer.ts` (`buildSteeringPrompt`, panduan diagnosis gate).
      Refiner diarahkan eksplisit: utamakan bentuk kondisional
      *"Saat X / Sebelum Y → lakukan Z"* di atas fakta mentah; satu pelajaran =
      satu aturan; sertakan evidence konkret.
- [x] **T1.2 Trial baru untuk item yang diperbaiki** *(bug halus)*
      File: `src/store.ts` (`applyOne` update branch).
      Update `content` yang benar-benar berubah → reset `applications/failures`
      ke 0 + hapus `lastOutcomeAt` (konten baru belum teruji). Update yang hanya
      menyentuh `importance/active/evidence` TIDAK mereset.
- [x] Test: reset terjadi pada perubahan konten; tidak terjadi pada bump importance.

## Tier 2 — Evolusi yang mengarah ke yang benar

- [x] **T2.1 Konsolidasi otomatis berkala (grow-and-refine ala ACE)**
      File baru: `src/consolidate.ts`; wiring di `src/outcome.ts` (turn_end part 4)
      + `src/index.ts` (reset cursor) + `src/config.ts`.
      Config: `consolidate: { enabled?: boolean; everyTurns?: number }`,
      default OFF / 25 turn. Tiap kadensi: jalankan dedupe proposer (delete
      near-duplicate) lalu `decayAndPrune`. Ter-audit via harness-state entries,
      notify ringkas hasilnya.
- [x] **T2.2 Konteks atribusi di evidence**
      File: `src/inject.ts` (catat id item yang barusan ter-inject),
      `src/refine.ts` (`gatherEvidence` menambahkan section
      "## Harness items injected during this window").
      Refiner jadi bisa membedakan "gagal KARENA catatan X salah" vs
      "gagal karena X tidak ada" → delta tepat sasaran, bukan tebakan duplikat.
- [x] Test: kadensi konsolidasi; konsolidasi mendedupe + prune; evidence
      mengandung daftar item ter-inject.

## Tier 3 — Ditunda (butuh dataoutcome terakumulasi)

- `/harness stats`: tren evolusi (failure rate turun? item terpromosi?)
- Demosi berbasis injeksi (ter-inject tapi turn dikoreksi user)
- Dedupe semantik berbasis embedding (biaya model call — bertentangan dengan
  prinsip gate murah; tunda sampai pola jelas)

## Definisi selesai

- Semua checkbox Tier 1–2 tercentang, test suite hijau penuh.
- Dokumentasi selaras: README (config `consolidate` + perilaku baru), CHANGELOG.
- Siklus refine berikutnya menghasilkan item berbentuk aturan keputusan.
