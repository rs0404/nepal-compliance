// Create a draft Purchase Invoice from a photo or PDF of the supplier's bill.
// The bill is read in this browser with Tesseract.js (or from the PDF's own text),
// so no AI service is used; the server only parses the text and learns from it.
frappe.provide("nepal_compliance.bill_scan");

(function () {
    const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
    const PDFJS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.min.js";
    const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js";
    const OCR_LANGUAGES = "eng+nep";
    const MAX_SIDE = 2400;
    const METHOD = "nepal_compliance.bill_scan.";

    const scripts = {};
    let worker_promise = null;
    let report_progress = () => {};

    function load_script(url) {
        scripts[url] = scripts[url] || new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = url;
            script.onload = resolve;
            script.onerror = () => {
                delete scripts[url];
                reject(new Error(__("Could not load the bill reader. Check the internet connection and try again.")));
            };
            document.head.appendChild(script);
        });
        return scripts[url];
    }

    async function get_worker() {
        await load_script(TESSERACT_URL);
        worker_promise = worker_promise || Tesseract.createWorker(OCR_LANGUAGES, 1, {
            logger: (message) => {
                if (message.status === "recognizing text") {
                    report_progress(__("Reading the bill… {0}%", [Math.round(message.progress * 100)]));
                } else if (message.status && message.status.includes("loading")) {
                    report_progress(__("Loading the bill reader (first time takes longer)…"));
                }
            },
        });
        return worker_promise;
    }

    function make_canvas(width, height) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
        return canvas;
    }

    // Grey paper, folds and shadows hide the text from the reader. Dividing the page by a
    // heavily blurred copy of itself (made by shrinking and enlarging it) leaves only the ink.
    function clean_page(source, width, height) {
        const longest = Math.max(width, height);
        const scale = longest > MAX_SIDE ? MAX_SIDE / longest : longest < 1200 ? 3 : 1;
        const page = make_canvas(width * scale, height * scale);
        const context = page.getContext("2d", { willReadFrequently: true });
        context.drawImage(source, 0, 0, page.width, page.height);

        const small = make_canvas(page.width / 40, page.height / 40);
        small.getContext("2d").drawImage(page, 0, 0, small.width, small.height);
        const paper = make_canvas(page.width, page.height);
        const paper_context = paper.getContext("2d", { willReadFrequently: true });
        paper_context.imageSmoothingQuality = "high";
        paper_context.drawImage(small, 0, 0, paper.width, paper.height);

        const ink = context.getImageData(0, 0, page.width, page.height);
        const background = paper_context.getImageData(0, 0, page.width, page.height).data;
        const pixels = ink.data;
        for (let i = 0; i < pixels.length; i += 4) {
            const value = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
            const paper_value = 0.299 * background[i] + 0.587 * background[i + 1] + 0.114 * background[i + 2];
            pixels[i] = pixels[i + 1] = pixels[i + 2] = Math.min(255, (value / (paper_value + 1)) * 255);
        }
        context.putImageData(ink, 0, 0);
        return page;
    }

    function load_image(blob) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            const url = URL.createObjectURL(blob);
            image.onload = () => {
                URL.revokeObjectURL(url);
                resolve(image);
            };
            image.onerror = () => reject(new Error(__("This image could not be opened.")));
            image.src = url;
        });
    }

    async function render_pdf(blob) {
        await load_script(PDFJS_URL);
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        const pdf = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
        const page = await pdf.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: MAX_SIDE / Math.max(base.width, base.height) });
        const canvas = make_canvas(viewport.width, viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        return canvas;
    }

    async function ocr(source, width, height) {
        const worker = await get_worker();
        const { data } = await worker.recognize(clean_page(source, width, height));
        return data.text || "";
    }

    function is_pdf(blob, name) {
        return blob.type === "application/pdf" || /\.pdf$/i.test(name || "");
    }

    // Text of the bill and how it was read: a digital PDF's own text, else OCR.
    async function read_bill(blob, file_url, name) {
        if (is_pdf(blob, name || file_url)) {
            report_progress(__("Reading the PDF…"));
            const text = (await frappe.xcall(METHOD + "extract_pdf_text", { file_url })) || "";
            if (text.trim().length > 50) {
                return { text, source: "PDF Text" };
            }
            const canvas = await render_pdf(blob);
            return { text: await ocr(canvas, canvas.width, canvas.height), source: "Scanned PDF" };
        }
        const image = await load_image(blob);
        return { text: await ocr(image, image.naturalWidth, image.naturalHeight), source: "Photo" };
    }

    async function upload(file) {
        const form = new FormData();
        form.append("file", file, file.name);
        form.append("is_private", 1);
        form.append("folder", "Home/Attachments");
        const response = await fetch("/api/method/upload_file", {
            method: "POST",
            body: form,
            headers: { Accept: "application/json", "X-Frappe-CSRF-Token": frappe.csrf_token },
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok || !json.message) {
            throw new Error(__("The bill could not be uploaded."));
        }
        return json.message.file_url;
    }

    function start() {
        const picker = new frappe.ui.Dialog({
            title: __("Purchase Invoice from Bill"),
            fields: [{ fieldtype: "HTML", fieldname: "picker" }],
        });
        const $body = picker.fields_dict.picker.$wrapper;
        $body.html(`
            <p class="text-muted">${__("Take a photo of the supplier's bill, or choose an image or PDF. It is read in this browser and no AI service is used. Lay the bill flat in good light.")}</p>
            <input type="file" class="form-control bill-scan-file" accept="image/*,application/pdf">
            <div class="bill-scan-progress text-muted small" style="margin-top: 12px"></div>
        `);
        const $progress = $body.find(".bill-scan-progress");
        report_progress = (message) => $progress.text(message);

        $body.find(".bill-scan-file").on("change", async (event) => {
            const file = event.target.files[0];
            if (!file) return;
            $(event.target).prop("disabled", true);
            try {
                report_progress(__("Uploading…"));
                const file_url = await upload(file);
                const { text, source } = await read_bill(file, file_url, file.name);
                report_progress(__("Matching the supplier…"));
                const company = frappe.defaults.get_user_default("Company");
                const analysis = await frappe.xcall(METHOD + "analyse_bill", { text, company });
                picker.hide();
                review({ file, file_url, text, source, company, analysis });
            } catch (error) {
                $(event.target).prop("disabled", false).val("");
                report_progress("");
                frappe.msgprint(error.message || String(error));
            }
        });
        picker.show();
    }

    function show_choices(dialog, fieldname, choices) {
        const $wrapper = dialog.fields_dict[fieldname].$wrapper;
        $wrapper.find(".bill-scan-choices").remove();
        if (!choices || !choices.length) return;
        const $box = $(`<div class="bill-scan-choices small text-muted" style="margin: -6px 0 10px"></div>`);
        $box.append($("<span>").text(__("Read from the bill:") + " "));
        choices.forEach((choice) => {
            $(`<button type="button" class="btn btn-xs btn-default" style="margin: 2px"></button>`)
                .text(choice.label)
                .on("click", () => dialog.set_value(fieldname, choice.value))
                .appendTo($box);
        });
        $wrapper.append($box);
    }

    function render_suppliers(dialog, analysis) {
        const $wrapper = dialog.fields_dict.supplier_choices.$wrapper.empty();
        const candidates = analysis.suppliers || [];
        if (!candidates.length) {
            $wrapper.html(`<p class="text-muted small">${__("No supplier was recognised on this bill. Choose it below; it will be recognised next time.")}</p>`);
            return;
        }
        const heading = analysis.supplier_confident
            ? __("Matched supplier")
            : __("Not sure which supplier this is. Pick one:");
        $wrapper.append($(`<div class="small text-muted" style="margin-bottom: 4px"></div>`).text(heading));
        candidates.forEach((candidate, index) => {
            const $option = $(`
                <label class="d-flex align-items-start" style="gap: 8px; margin-bottom: 6px; cursor: pointer">
                    <input type="radio" name="bill-scan-supplier" style="margin-top: 4px">
                    <span><b class="supplier-name"></b> <span class="badge badge-light score"></span><br>
                    <span class="small text-muted reasons"></span></span>
                </label>`);
            $option.find(".supplier-name").text(candidate.supplier_name || candidate.supplier);
            $option.find(".score").text(__("{0}% match", [candidate.score]));
            $option.find(".reasons").text(candidate.reasons.join(" · "));
            $option.find("input")
                .prop("checked", analysis.supplier_confident && index === 0)
                .on("change", () => dialog.set_value("supplier", candidate.supplier));
            $wrapper.append($option);
        });
    }

    function amount_before_vat(values, vat_set) {
        const total = flt(values.total);
        if (values.is_pan_bill) return total;
        if (vat_set && Math.abs(flt(vat_set.total) - total) <= 1) return flt(vat_set.taxable);
        return flt(total / 1.13, 2);
    }

    function review({ file, file_url, text, source, company, analysis }) {
        let context = analysis.context || {};
        // analyse_bill already sent the context of the best match
        let context_supplier = analysis.suppliers && analysis.suppliers.length ? analysis.suppliers[0].supplier : null;
        let amount_edited = false;
        const dialog = new frappe.ui.Dialog({
            title: __("Check the Bill"),
            size: "extra-large",
            fields: [
                { fieldtype: "HTML", fieldname: "preview" },
                { fieldtype: "Column Break" },
                { fieldtype: "Link", fieldname: "company", label: __("Company"), options: "Company", reqd: 1, default: company },
                { fieldtype: "HTML", fieldname: "supplier_choices" },
                {
                    fieldtype: "Link", fieldname: "supplier", label: __("Supplier"), options: "Supplier", reqd: 1,
                    onchange: () => load_supplier(dialog.get_value("supplier")),
                },
                { fieldtype: "Data", fieldname: "bill_no", label: __("Supplier Invoice No"), onchange: () => check_duplicate() },
                { fieldtype: "HTML", fieldname: "duplicate_warning" },
                { fieldtype: "Date", fieldname: "bill_date", label: __("Supplier Invoice Date") },
                {
                    fieldtype: "Check", fieldname: "is_pan_bill", label: __("PAN / Abbreviated Bill (no VAT)"),
                    onchange: () => update_amount(),
                },
                { fieldtype: "Currency", fieldname: "total", label: __("Bill Total"), reqd: 1, onchange: () => update_amount() },
                {
                    fieldtype: "Currency", fieldname: "amount", label: __("Amount Before VAT"), reqd: 1,
                    description: __("Becomes the item rate. VAT is added by the tax template."),
                    onchange: () => { amount_edited = dialog.get_value("amount") !== amount_before_vat(dialog.get_values(true), analysis.vat_set); },
                },
                { fieldtype: "Link", fieldname: "item_code", label: __("Item"), options: "Item", reqd: 1 },
                {
                    fieldtype: "Link", fieldname: "taxes_and_charges", label: __("Purchase Taxes and Charges Template"),
                    options: "Purchase Taxes and Charges Template",
                    get_query: () => ({ filters: { company: dialog.get_value("company"), disabled: 0 } }),
                },
                { fieldtype: "Section Break", label: __("Text Read From the Bill"), collapsible: 1 },
                { fieldtype: "HTML", fieldname: "text" },
            ],
            primary_action_label: __("Create Draft Invoice"),
            primary_action: (values) => create(values),
        });

        const preview_url = URL.createObjectURL(file);
        dialog.fields_dict.preview.$wrapper.html(is_pdf(file, file.name)
            ? `<iframe src="${preview_url}" style="width: 100%; height: 70vh; border: 0"></iframe>`
            : `<img src="${preview_url}" style="width: 100%; max-height: 75vh; object-fit: contain">`);
        dialog.fields_dict.text.$wrapper.html(
            $(`<pre class="small" style="white-space: pre-wrap; max-height: 300px; overflow: auto"></pre>`).text(text || __("(nothing could be read)"))
        );
        dialog.onhide = () => URL.revokeObjectURL(preview_url);

        function update_amount() {
            if (!amount_edited) {
                dialog.set_value("amount", amount_before_vat(dialog.get_values(true), analysis.vat_set));
            }
        }

        async function check_duplicate() {
            const { supplier, bill_no } = dialog.get_values(true);
            const $warning = dialog.fields_dict.duplicate_warning.$wrapper.empty();
            if (!supplier || !bill_no) return;
            const existing = await frappe.xcall(METHOD + "find_duplicate_bills", { supplier, bill_no });
            if (existing.length) {
                $warning.html(`<div class="alert alert-warning small">${__("This bill is already entered as {0}.", [
                    existing.map((name) => frappe.utils.get_form_link("Purchase Invoice", name, true)).join(", "),
                ])}</div>`);
            }
        }

        function apply_context() {
            show_choices(dialog, "bill_no", (context.bill_no_candidates || []).map((c) => ({ label: c.value, value: c.value })));
            const bill_no = (context.bill_no_candidates || [])[0];
            if (bill_no && !dialog.get_value("bill_no")) dialog.set_value("bill_no", bill_no.value);
            if (context.items && context.items.length) {
                dialog.set_value("item_code", context.items[0]);
                show_choices(dialog, "item_code", context.items.map((item) => ({ label: item, value: item })));
            }
            if (context.taxes_and_charges) dialog.set_value("taxes_and_charges", context.taxes_and_charges);
            if (context.invoice_count) dialog.set_value("is_pan_bill", context.is_pan_bill ? 1 : 0);
            check_duplicate();
        }

        async function load_supplier(supplier) {
            if (!supplier || supplier === context_supplier) return;
            context_supplier = supplier;
            context = await frappe.xcall(METHOD + "supplier_context", { supplier, text, company: dialog.get_value("company") });
            apply_context();
        }

        async function create(values) {
            dialog.disable_primary_action();
            try {
                const name = await frappe.xcall(METHOD + "create_purchase_invoice", {
                    data: { ...values, file_url, text, source },
                });
                dialog.hide();
                frappe.show_alert({ message: __("Draft {0} created. Check the items before submitting.", [name]), indicator: "green" });
                frappe.set_route("Form", "Purchase Invoice", name);
            } finally {
                dialog.enable_primary_action();
            }
        }

        render_suppliers(dialog, analysis);
        const dates = analysis.dates || [];
        show_choices(dialog, "bill_date", dates.map((d) => ({ label: d.label, value: d.value })));
        if (dates.length) dialog.set_value("bill_date", dates[0].value);
        const totals = analysis.totals || [];
        show_choices(dialog, "total", totals.map((t) => ({ label: format_currency(t.value), value: t.value })));
        if (totals.length) dialog.set_value("total", totals[0].value);
        if (analysis.supplier_confident) {
            dialog.set_value("supplier", context_supplier);
            apply_context();
        } else {
            context_supplier = null;
        }
        dialog.show();
    }

    // Read the bills already attached to submitted Purchase Invoices, so their suppliers are
    // recognised on the next upload. Runs in this browser, one bill at a time.
    async function learn_past_bills(limit) {
        const bills = await frappe.xcall(METHOD + "get_unlearned_bills", { limit });
        if (!bills.length) {
            frappe.msgprint(__("Every attached bill has already been learned."));
            return;
        }
        let stopped = false;
        const dialog = new frappe.ui.Dialog({
            title: __("Learning From Past Bills"),
            fields: [{ fieldtype: "HTML", fieldname: "status" }],
            primary_action_label: __("Stop"),
            primary_action: () => { stopped = true; },
        });
        const $status = dialog.fields_dict.status.$wrapper;
        dialog.show();
        let learned = 0;
        for (const [index, bill] of bills.entries()) {
            if (stopped) break;
            report_progress = (message) => $status.text(`${index + 1} / ${bills.length}: ${message}`);
            report_progress(__("Downloading…"));
            try {
                const response = await fetch(bill.file_url);
                if (!response.ok) continue;
                const { text, source } = await read_bill(await response.blob(), bill.file_url, bill.file_url);
                if (await frappe.xcall(METHOD + "learn_from_invoice", { purchase_invoice: bill.purchase_invoice, text, source })) {
                    learned++;
                }
            } catch (error) {
                console.warn("Bill not learned", bill.purchase_invoice, error);
            }
        }
        dialog.hide();
        frappe.msgprint(__("Learned {0} of {1} bills.", [learned, bills.length]));
    }

    Object.assign(nepal_compliance.bill_scan, { start, learn_past_bills });
})();

if (!frappe.listview_settings["Purchase Invoice"]) {
    frappe.listview_settings["Purchase Invoice"] = {};
}
(function (settings) {
    const onload = settings.onload;
    settings.onload = function (listview) {
        if (onload) onload.call(this, listview);
        if (frappe.model.can_create("Purchase Invoice")) {
            listview.page.add_inner_button(__("From Bill Photo"), () => nepal_compliance.bill_scan.start(), __("Create"));
        }
    };
})(frappe.listview_settings["Purchase Invoice"]);
