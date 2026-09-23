/** Optional metadata kept beside numbered animation frames. Legacy sequences use 30 fps. */
export const SEQUENCE_METADATA_FILE = '.sequence.json';

export function parseSequenceMetadata(value: unknown): { frameRate: number } {
	if (!value || typeof value !== 'object' || !('frameRate' in value)
		|| typeof value.frameRate !== 'number' || !Number.isFinite(value.frameRate)
		|| value.frameRate < 1 || value.frameRate > 240) {
		throw new Error('Sequence metadata must specify a frameRate between 1 and 240.');
	}
	return { frameRate: value.frameRate };
}
