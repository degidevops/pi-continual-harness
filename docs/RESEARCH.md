# Rujukan Riset: Self-Improving & Continual Harness (2025–2026)

Kumpulan riset terbaru yang menjadi landasan dan peta jalan evolusi
pi-continual-harness. Disusun setelah implementasi Evolution v2
(lihat `PLAN-EVOLUTION.md`). Dua paper fondasi sudah diadopsi penuh;
sisanya adalah kandidat arah pengembangan Tier berikutnya.

## 1. Fondasi yang sudah diadopsi

### Continual Harness: Online Adaptation for Self-Improving Foundation Agents
- **Sumber**: [arXiv 2605.09998](https://arxiv.org/abs/2605.09998) · [GitHub](https://github.com/sethkarten/continual-harness)
- **Inti**: reset-free framework — refiner otomatis membaca trajectory window
  untuk *failure signatures* lalu menerapkan edit CRUD ke empat komponen
  harness (prompt, sub-agent, skills, memory). Recovers mayoritas gap ke
  expert harness tanpa intervensi manusia.
- **Diadopsi**: failure-signature gate, four-pass refinement, repair skill
  yang raise exception, bootstrap antar-sesi via durable export/import.

### Agentic Context Engineering (ACE)
- **Sumber**: [arXiv 2510.04618](https://arxiv.org/abs/2510.04618) · **diterima ICLR 2026** · [GitHub](https://github.com/ace-agent/ace) · [Microsoft Research](https://www.microsoft.com/en-us/research/publication/agentic-context-engineering-evolving-contexts-for-self-improving-language-models/)
- **Inti**: konteks sebagai *evolving playbook* dengan update incremental
  itemized (generator/reflector/curator). Melawan *brevity bias* dan
  *context collapse*.
- **Diadopsi**: delta CRUD itemized bersyarat evidence, grow-and-refine,
  anti-collapse via dedupe + bounded injection.

## 2. Frontier baru — relevan untuk roadmap berikutnya

### Harness Continual Learning (HCL) — *harness-level forgetting*
- **Sumber**: [arXiv 2608.19013](https://arxiv.org/abs/2608.19013)
- **Masalah**: saat harness di-update di sekitar model beku, perilaku yang
  tadinya andal bisa rusak — *harness-level forgetting*. Ini formalisasi dari
  risiko regresi yang kita mitigasi secara pragmatis (fitness ranking, decay
  resistance, fair trials).
- **Kandidat adopsi**: *regression guard* — sebelum batch delta otonom
  diterapkan, bandingkan agregat fitness store sebelum/sesudah; rollback
  otomatis bila menurun signifikan.

### Test-Time Harness Evolution (TTHE)
- **Sumber**: [arXiv 2607.08124](https://arxiv.org/abs/2607.08124) · [GitHub](https://github.com/junnie00/TTHE)
- **Inti**: optimasi harness saat evaluasi hanya dari execution traces tanpa
  label; beberapa kandidat edit dibuat lalu *agentic judge* memilih varian
  terbaik. Hingga +38 poin akurasi pada Text-to-SQL.
- **Kandidat adopsi**: refine menghasilkan ≥2 kandidat delta, judge murah
  memilih — daripada langsung apply.

### Recursive Harness Self-Improvement (RHI)
- **Sumber**: [arXiv 2607.15524](https://arxiv.org/abs/2607.15524)
- **Inti**: harness sebagai spesifikasi prompt-level dari agent loop, diperhalus
  lewat *pairwise feedback atas riwayat revisinya sendiri*. Gain datang dari
  manajemen konteks antar-agent yang lebih efektif, bukan reasoning lebih
  panjang; biaya inferensi turun hingga ~60%.
- **Kandidat adopsi**: snapshot `harness-state` per mutasi = riwayat revisi
  siap dipakai untuk perbandingan pairwise ("versi mana menghasilkan outcome
  lebih baik?") sebagai dasar promosi/demosi yang lebih adil.

### Aliran skill self-evolution (konteks luas)
| Paper | Sumber | Inti |
|---|---|---|
| Evo-Harness | [2608.15071](https://arxiv.org/abs/2608.15071) | Kompilasi context-to-harness |
| AutoSkill | [2603.01145](https://arxiv.org/abs/2603.01145) | Skill self-evolution dari pengalaman |
| ReMe (ACL 2026 Findings) | [link](https://aclanthology.org/2026.findings-acl.829/) | Remember–Refine procedural memory |
| Experiential Reflective Learning | [2603.24639](https://arxiv.org/abs/2603.24639) | Distilasi pengalaman → skill reusable |
| Voyager | [2305.16291](https://arxiv.org/abs/2305.16291) | Leluhur skill library tumbuh-sendiri |

### Aliran prompt-centric
| Paper | Sumber | Inti |
|---|---|---|
| MemAPO | [2603.21520](https://arxiv.org/abs/2603.21520) | Memori self-evolving untuk prompt optimization |
| SePO | [2606.04465](https://arxiv.org/html/2606.04465) | System prompt yang berevolusi sendiri |

## 3. Catatan kritis literatur

- Hampir semua masih preprint 2025–2026 dengan sitasi minim → validasi empiris
  terbatas.
- Evaluasi didominasi domain mainan (Pokémon, Minecraft) atau benchmark
  sintetis; robustness dunia nyata belum terbukti.
- Klaim "update tanpa melupakan" (HCL, TTHE) masih area riset aktif — risiko
  *harness-level forgetting* adalah alasan desain defensif kita (fitness loop,
  audit trail, rollback `/tree`, fair trials) tetap dipertahankan.

## 4. Implikasi roadmap

1. **Regression guard ala HCL** — tolak batch delta otonom yang menurunkan
   agregat fitness store secara signifikan (rollback otomatis).
2. **Pairwise revision feedback ala RHI** — bandingkan revisi item memakai
   snapshot historis untuk promosi/demosi yang lebih adil.
3. **Candidate selection ala TTHE** — refine menghasilkan beberapa kandidat,
   judge murah memilih.
4. `/harness stats`, demosi berbasis injeksi, dedupe semantik — tetap menunggu
   volume data outcome/injection terakumulasi (lihat `PLAN-EVOLUTION.md`
   Tier 3).
