# Sismografia · NBR 9653 · US Vale Verde

Dashboard interativo de sismografia do desmonte com explosivos — vibração (PPV),
frequência dominante, sobrepressão acústica (airblast) e distância escalonada,
com conformidade avaliada conforme **NBR 9653:2018** (curva única PPV×frequência)
e referências internacionais (DIN 4150-3 e USBM RI 8507).

## Online
https://silvathiagoferreira.github.io/sismografia-us-vale-verde/

## Como funciona
- Site estático (HTML/CSS/JS + Chart.js via CDN), hospedado no GitHub Pages.
- Lê em tempo real a planilha de sismografia da US Vale Verde (Google Sheets, API gviz)
  — atualiza a cada acesso, sem servidor nem build.

## Fonte de dados
Google Sheet da US Vale Verde (3084 eventos, jul/2020–jun/2026).
