# Convert

Convertor de fișiere care rulează **complet în browser**. Fără server, fără upload, fără limite de fișiere sau conversii pe zi.

## Ce convertește

| Din | În |
|---|---|
| Poze (PNG, JPG, WebP, HEIC, AVIF, BMP, GIF, SVG, TIFF) | JPG, PNG, WebP, PDF |
| Video (MOV, MP4, MKV, WebM, AVI, WMV, FLV, 3GP…) | MP4, MOV, MKV, WebM, AVI, GIF, MP3, WAV, M4A |
| Audio (MP3, WAV, M4A, AAC, OGG, OPUS, FLAC, WMA…) | MP3, WAV, M4A, OGG, FLAC |
| PDF | Word (DOCX), JPG, PNG, TXT |
| Word (DOCX) | PDF, TXT |
| TXT / MD | PDF, DOCX |

## Ce să știi

- **MOV → MP4** de la iPhone e de obicei instant: schimbă doar containerul, fără pierdere de calitate. Re-encode doar când chiar trebuie.
- Video/audio folosesc `ffmpeg.wasm`: prima dată se descarcă ~30 MB, apoi rămâne în cache (merge și offline).
- **Word → PDF** iese vizual fidel, dar textul din PDF e imagine (nu se poate selecta).
- **PDF → Word** scoate textul pe paragrafe, fără layout-ul exact. PDF-urile scanate ajung ca imagini în Word (fără OCR).
- `.doc` vechi nu e suportat — salvează-l ca `.docx`.
- Fișierele video foarte mari (peste ~1 GB) pot depăși memoria browserului, mai ales pe iPhone.

## Pe iPhone

Deschide pagina în Safari → Share → **Add to Home Screen**. După conversie, butonul **Salvează / Trimite** te lasă să pui fișierul direct în Poze sau Fișiere.
