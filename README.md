# Convert

Convertor și editor PDF care rulează **complet în browser**. Fără server, fără upload, fără limite.

**Live:** https://razvntv-crypto.github.io/convert/

## Conversii

| Din | În |
|---|---|
| Poze (PNG, JPG, WebP, HEIC, AVIF, BMP, GIF, SVG, TIFF) | JPG, PNG, WebP, PDF, Comprimă, Word/TXT cu OCR |
| Video (MOV, MP4, MKV, WebM, AVI, WMV, FLV, 3GP…) | MP4, MOV, MKV, WebM, AVI, GIF, MP3, WAV, M4A, Comprimă |
| Audio (MP3, WAV, M4A, AAC, OGG, OPUS, FLAC, WMA…) | MP3, WAV, M4A, OGG, FLAC |
| PDF | Word (cu OCR pe pagini scanate), JPG, PNG, TXT, PowerPoint, PDF căutabil (OCR), Comprimă, Unește, Separă pagini |
| Word (DOCX) | PDF, TXT |
| Excel (XLSX, XLS, ODS, CSV) | PDF, XLSX, CSV |
| TXT / MD | PDF, DOCX |

Extra: tăiere video/audio (de la… până la…), scos sunetul, rezoluție maximă pentru video, latura maximă pentru poze.

## Editor PDF (`edit.html`)

- **Editează text direct:** click pe un text din PDF și îl rescrii. Fontul (Arial/Times-compatibil), mărimea, culoarea și fundalul sunt detectate automat.
- Text nou, desen liber, semnătură (salvată pentru data viitoare), poze, acoperire zone, marcator, decupare.
- Pagini: rotire, ștergere, reordonare.
- Numerotare pagini, watermark.
- Completare formulare PDF.
- Opțional: șterge definitiv textul acoperit (paginile editate devin imagine).

## Ce să știi

- **MOV → MP4** de la iPhone e de obicei instant: schimbă doar containerul, fără pierdere de calitate.
- Prima folosire descarcă librăriile (ffmpeg ~30 MB, OCR ~15 MB). Apoi rămân în cache și merg offline.
- **Word/Excel → PDF:** aspect fidel, dar textul din PDF e imagine. Trece-l prin „PDF căutabil” dacă vrei text selectabil.
- **PDF → Word:** textul pe paragrafe, fără layout-ul exact. OCR-ul e foarte bun pe scanuri curate și mai slab pe poze strâmbe.
- `.doc` vechi și PowerPoint → PDF nu sunt suportate în browser.
- Fișierele video foarte mari (peste ~1 GB) pot depăși memoria browserului, mai ales pe iPhone.

## Pe iPhone

Safari → Share → **Add to Home Screen**. Butonul **Salvează / Trimite** pune fișierul direct în Poze sau Fișiere.
