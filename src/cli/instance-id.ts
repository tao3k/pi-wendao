const INSTANCE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{2,127}$/;

export function validateInstanceId(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!INSTANCE_ID_PATTERN.test(trimmed) || /^\d+$/.test(trimmed)) {
		throw new Error(
			`invalid --instance-id "${value}"; use 3-128 characters, start with a letter, and use only letters, numbers, "_", "-", ".", or ":"`,
		);
	}
	return trimmed;
}
