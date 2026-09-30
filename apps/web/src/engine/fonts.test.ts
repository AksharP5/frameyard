import { afterEach, expect, it, vi } from 'vitest';
import { getLocalFonts } from './fonts';

afterEach(() => vi.unstubAllGlobals());

it('recognizes separated local font weight names without matching the shorter weight', async () => {
	const styles = ['Extra Bold', 'Ultra-Bold', 'Semi Bold', 'Demi-Bold', 'Extra Light', 'Ultra-Light', 'Bold', 'Light'];
	vi.stubGlobal('window', { queryLocalFonts: async () => styles.map(style => ({
		family: 'Example', fullName: `Example ${style}`, postscriptName: `Example-${style}`, style,
	})) });
	const [font] = await getLocalFonts();
	expect(font.variants.map(variant => variant.weight)).toEqual(['800', '800', '600', '600', '200', '200', '700', '300']);
});

it('escapes local font names for CSS sources', async () => {
	vi.stubGlobal('window', { queryLocalFonts: async () => [{
		family: "Artist's Font", fullName: "Artist's Font", postscriptName: 'Artist\\Font', style: 'Regular',
	}] });
	const [font] = await getLocalFonts();
	expect(font.variants[0].source).toBe("local('Artist\\'s Font'), local('Artist\\\\Font')");
});
