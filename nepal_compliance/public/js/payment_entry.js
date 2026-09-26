// Customer TDS on the Payment Entry form: when the customer withholds TDS, Paid
// Amount is filled in as the allocated total less the TDS, and the TDS is shown in
// Deductions against the company's TDS Receivable Account. customer_tds.apply_customer_tds
// books the same on save, so this only keeps the form in step while it is edited.
const CUSTOMER_TDS = "nepal_compliance.customer_tds";

frappe.ui.form.on("Payment Entry", {
    setup(frm) {
        frm.set_query("tds_receivable_account", () => ({
            filters: { company: frm.doc.company, is_group: 0 },
        }));
    },
    company(frm) {
        load_customer_tds_defaults(frm, true);
    },
    party(frm) {
        load_customer_tds_defaults(frm, false);
    },
    mode_of_payment(frm) {
        schedule_customer_tds(frm);
    },
    apply_customer_tds(frm) {
        schedule_customer_tds(frm);
    },
    tds_receivable_account(frm) {
        schedule_customer_tds(frm);
    },
});

frappe.ui.form.on("Payment Entry Reference", {
    reference_name(frm) {
        schedule_customer_tds(frm);
    },
    allocated_amount(frm) {
        schedule_customer_tds(frm);
    },
    references_remove(frm) {
        schedule_customer_tds(frm);
    },
});

function is_customer_receipt(frm) {
    return (
        frm.doc.docstatus === 0 &&
        frm.doc.payment_type === "Receive" &&
        frm.doc.party_type === "Customer" &&
        frm.doc.party &&
        frm.doc.company
    );
}

async function load_customer_tds_defaults(frm, company_changed) {
    if (!is_customer_receipt(frm)) return;
    const r = await frappe.call({
        method: `${CUSTOMER_TDS}.get_customer_tds_defaults`,
        args: { company: frm.doc.company, customer: frm.doc.party },
    });
    const defaults = r.message || {};
    await frm.set_value("apply_customer_tds", defaults.apply ? 1 : 0);
    // Each company has its own TDS Receivable Account in Nepal Compliance Settings.
    if (company_changed || !frm.doc.tds_receivable_account) {
        await frm.set_value("tds_receivable_account", defaults.account || null);
    }
    schedule_customer_tds(frm);
}

// ERPNext re-allocates the references asynchronously after most of these changes
// (Mode of Payment sets the bank account, which reloads its balance), so wait for
// its calls to finish before recalculating.
function schedule_customer_tds(frm) {
    clearTimeout(frm.customer_tds_timer);
    frm.customer_tds_timer = setTimeout(() => frappe.after_ajax(() => apply_customer_tds(frm)), 200);
}

async function apply_customer_tds(frm) {
    if (frm.customer_tds_running || !is_customer_receipt(frm)) return;
    frm.customer_tds_running = true;
    try {
        const account = frm.doc.tds_receivable_account;
        const invoices = (frm.doc.references || [])
            .filter((ref) => ref.reference_doctype === "Sales Invoice" && ref.reference_name)
            .map((ref) => ref.reference_name);
        let tds_by_invoice = {};
        if (frm.doc.apply_customer_tds && account && invoices.length) {
            const r = await frappe.call({
                method: `${CUSTOMER_TDS}.get_invoice_tds`,
                args: {
                    company: frm.doc.company,
                    invoices,
                    payment_entry: frm.is_new() ? null : frm.doc.name,
                },
            });
            tds_by_invoice = r.message || {};
        }

        // Keep the allocation as it is: setting Paid Amount makes ERPNext
        // re-allocate against it, which would leave the TDS outstanding.
        const allocations = (frm.doc.references || []).map((ref) => flt(ref.allocated_amount));
        const counted = new Set();
        let total_tds = 0;
        for (const ref of frm.doc.references || []) {
            // the TDS goes on the first row of each invoice, as on the server
            const tds = counted.has(ref.reference_name) ? 0 : flt(tds_by_invoice[ref.reference_name]);
            counted.add(ref.reference_name);
            ref.customer_tds_amount = tds;
            total_tds += tds;
        }

        const had_tds = (frm.doc.deductions || []).some((d) => account && d.account === account);
        frm.doc.deductions = (frm.doc.deductions || []).filter((d) => !account || d.account !== account);
        frm.doc.deductions.forEach((d, i) => (d.idx = i + 1));
        if (total_tds) {
            const cost_center =
                frm.doc.cost_center ||
                (await frappe.db.get_value("Company", frm.doc.company, "cost_center")).message.cost_center;
            frm.add_child("deductions", {
                account,
                cost_center,
                amount: total_tds,
                description: __("TDS withheld by customer on {0}", [Object.keys(tds_by_invoice).join(", ")]),
            });
        }
        frm.refresh_field("deductions");
        await frm.set_value("customer_tds_amount", total_tds);

        // Leave Paid Amount alone for a receipt with no customer TDS, e.g. an advance.
        if (!total_tds && !had_tds) return;
        const allocated = allocations.reduce((sum, amount) => sum + amount, 0);
        await frm.set_value("paid_amount", flt(allocated - total_tds, precision("paid_amount")));

        await new Promise((resolve) => frappe.after_ajax(resolve));
        (frm.doc.references || []).forEach((ref, i) => (ref.allocated_amount = allocations[i]));
        frm.refresh_field("references");
        frm.events.set_total_allocated_amount(frm);
    } finally {
        frm.customer_tds_running = false;
    }
}
