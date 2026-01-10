import puppeteer from "puppeteer";

export async function renderQuestionToImage(question: string, options: string[]): Promise<Buffer> {
    const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        headless: true
    });
    const page = await browser.newPage();

    // Set viewport to reasonable width, height will adjust
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });

    const optionsHtml = options.map((opt, i) => {
        const label = String.fromCharCode(65 + i); // A, B, C...
        return `<div class="option">
            <span class="label">${label})</span>
            <span class="content">${escapeHtml(opt)}</span>
        </div>`;
    }).join("");

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap" rel="stylesheet">
        <style>
            body { 
                font-family: 'Montserrat', sans-serif;
                padding: 60px; 
                background: #212121; 
                width: fit-content;
                min-width: 600px;
                max-width: 800px;
                box-sizing: border-box;
                color: #ececec;
            }
            .question { 
                font-size: 28px; 
                font-weight: 500;
                margin-bottom: 30px; 
                line-height: 1.6;
                color: #ececec;
            }
            .options {
                display: flex;
                flex-direction: column;
                gap: 15px;
            }
            .option { 
                font-size: 24px; 
                display: flex; 
                align-items: flex-start;
                line-height: 1.4;
                color: #ececec;
                background: #333333;
                padding: 15px;
                border-radius: 8px;
            }
            .label { 
                font-weight: bold; 
                margin-right: 15px; 
                color: #bdbdbd;
                min-width: 25px;
            }
            .content {
                word-break: break-word;
            }
            /* Vertical align fix for inline math */
            mjx-container[jax="SVG"][display="true"] {
                margin: 1em 0 !important;
            }
            /* MathJax color fix for dark mode */
            mjx-container path {
                fill: #ececec !important;
            }
        </style>
        <script>
        window.MathJax = {
            tex: {
                inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
                displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']],
                packages: {'[+]': ['noerrors', 'noundefined']}
            },
            loader: {load: ['[tex]/noerrors', '[tex]/noundefined']},
            startup: {
                pageReady: () => {
                    return MathJax.startup.defaultPageReady().then(() => {
                        document.body.classList.add('mathjax-ready');
                    });
                }
            },
            chtml: {
                fontURL: 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/output/chtml/fonts/woff-v2'
            },
            svg: {
                fontCache: 'global'
            }
        };
        </script>
        <script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js"></script>
    </head>
    <body>
        <div id="container">
            <div class="question">${escapeHtml(question)}</div>
            <div class="options">
                ${optionsHtml}
            </div>
        </div>
    </body>
    </html>
    `;

    await page.setContent(html);

    // Wait for MathJax to finish
    await page.waitForSelector('.mathjax-ready', { timeout: 15000 }).catch(() => {
        console.warn("MathJax did not signal ready, taking screenshot anyway");
    });

    // Additional wait to ensure layout is stable
    await new Promise(r => setTimeout(r, 100));

    // Get the bounding box of the container
    const element = await page.$('body');
    if (!element) {
        await browser.close();
        throw new Error("Container element not found");
    }

    const imageBuffer = await element.screenshot({ type: 'png', omitBackground: true });

    await browser.close();
    
    // Puppeteer returns Uint8Array in recent versions or Buffer depending on config, 
    // but in Node environment it's usually Buffer. Bun might treat it as Uint8Array.
    // We cast to Buffer just to be sure if downstream needs it, although standard Buffer is Uint8Array subclass.
    return Buffer.from(imageBuffer);
}

function escapeHtml(unsafe: string): string {
    // We only escape basic HTML chars, but we MUST preserve LaTeX delimiters if they use & etc?
    // Actually, text content usually doesn't have & unless part of math.
    // If we escape &, we might break LaTeX like \begin{align} & \end{align}.
    // But if we don't, we risk HTML injection.
    // Compromise: Escape < and > but trust & mostly, or just simple replace.
    // For now, standard escape.
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
