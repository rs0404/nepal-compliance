// A short summary of IRD's PAN search answer, for the popup. The ERP keeps its
// own parser (nepal_compliance/ird_bridge.py parse_pan_response); keep the two
// code tables in sync with IRD's page.
export const ACCOUNT_TYPES = {
	"00": "VAT",
	"10": "Income Tax",
	"11": "WPAN",
	"20": "Excise",
	"30": "Personal PAN",
	"40": "Health Tax",
	"50": "Education Tax",
	"60": "DST",
	"61": "Non-Resident Airlines",
};
export const ACCOUNT_STATUSES = { A: "Active", C: "Closed", D: "Deactivated" };

const VAT = "00";
const PERSONAL = "30";
const ACTIVE = "A";

const text = (value) => (value == null ? "" : String(value).trim());
const rows = (value) => (Array.isArray(value) ? value.filter((row) => row && typeof row === "object") : []);

export function isNotFound(response) {
	if (!response || typeof response !== "object") return true;
	if (response.error || response.code === 0) return true;
	const data = response.data;
	return !data || typeof data !== "object" || !rows(data.panDetails).length;
}

function panStatus(registrations) {
	const statuses = registrations.map((row) => row.status).filter(Boolean);
	const suspended = statuses.filter((status) => status.toLowerCase().includes("suspend"));
	if (suspended.length) return [...new Set(suspended)].join(", ");
	if (registrations.some((row) => row.statusCode === ACTIVE)) return ACCOUNT_STATUSES[ACTIVE];
	return [...new Set(statuses)].join(", ");
}

export function summarisePanResponse(pan, response) {
	if (isNotFound(response)) return { found: false, pan };

	const data = response.data;
	const detail = rows(data.panDetails)[0];
	const registrations = rows(data.panRegistrationDetail).map((row) => {
		const typeCode = text(row.acctType);
		const statusCode = text(row.accountStatus);
		return {
			typeCode,
			type: ACCOUNT_TYPES[typeCode] || typeCode,
			statusCode,
			status: ACCOUNT_STATUSES[statusCode] || statusCode,
			registrationDate: text(row.registrationDate),
		};
	});
	const isPersonalPan = registrations.length > 0 && registrations.every((row) => row.typeCode === PERSONAL);

	return {
		found: true,
		pan: text(detail.pan) || pan,
		nameEn: text(detail.trade_Name_Eng),
		nameNp: text(detail.trade_Name_Nep),
		address: [text(detail.vdc_Town), text(detail.street_Name)].filter(Boolean).join(" "),
		office: text(detail.office_Name),
		status: panStatus(registrations),
		isPersonalPan,
		vatRegistered: registrations.some((row) => row.typeCode === VAT && row.statusCode === ACTIVE),
		registrations,
	};
}
