import { describe, expect, it } from 'vitest';
import { matchesSearch, normalizeForSearch, searchWords } from './fileSearch.js';

// The search over the Sent and Received lists: names and folders, without regard to case or accents.

function matches(query: string, name: string, relativePath?: string): boolean {
    return matchesSearch(searchWords(query), [name, relativePath]);
}

describe('normalizeForSearch', () => {
    it('drops case and accents, Greek tonos and dialytika included, and reads final sigma as sigma', () => {
        // Act
        const normalized = ['Αθηναίισσα.mp3', 'ΣΟΥ', 'σου', 'Café Ünïcode', 'ΐδιος ΰψος', 'Δρόμος']
            .map(normalizeForSearch);

        // Assert
        expect(normalized).toEqual(['αθηναιισσα.mp3', 'σου', 'σου', 'cafe unicode', 'ιδιοσ υψοσ', 'δρομοσ']);
    });
});

describe('searchWords', () => {
    it('splits on any run of spaces and drops empty words', () => {
        // Act
        const words = searchWords('  Trip\t ΤΑΞΊΔΙ  ');

        // Assert
        expect(words).toEqual(['trip', 'ταξιδι']);
    });
});

describe('matchesSearch', () => {
    it('finds Greek names without case or accents', () => {
        // Act & Assert
        expect(matches('αθηναι', 'Αθηναίισσα.mp3')).toBe(true);
        expect(matches('ΣΟΥ', 'σου.mp3')).toBe(true);
        expect(matches('δρομος', 'ΔΡΌΜΟΣ.mp3')).toBe(true);
        expect(matches('remb', 'Ρεμπέτικα.mp3', 'Ρεμπέτικα/Ρεμπέτικα.mp3')).toBe(false);
    });

    it('finds Latin names without case or accents', () => {
        // Act & Assert
        expect(matches('img_22', 'IMG_2231.JPG')).toBe(true);
        expect(matches('cafe', 'Café.png')).toBe(true);
        expect(matches('CAFÉ', 'cafe.png')).toBe(true);
        expect(matches('img_99', 'IMG_2231.JPG')).toBe(false);
    });

    it('looks in the folder path as well as the name', () => {
        // Act & Assert
        expect(matches('trip', 'IMG_1.jpg', 'Trip/Day 1/IMG_1.jpg')).toBe(true);
        expect(matches('day 1', 'IMG_1.jpg', 'Trip/Day 1/IMG_1.jpg')).toBe(true);
        expect(matches('trip', 'IMG_1.jpg')).toBe(false);
    });

    it('needs every word, in any order', () => {
        // Act & Assert
        expect(matches('mountains summer', 'peak.jpg', 'Summer 2026/Mountains/peak.jpg')).toBe(true);
        expect(matches('summer beach', 'peak.jpg', 'Summer 2026/Mountains/peak.jpg')).toBe(false);
    });

    it('matches everything when the search is empty or only spaces', () => {
        // Act & Assert
        expect(matches('', 'a.jpg')).toBe(true);
        expect(matches('   ', 'a.jpg')).toBe(true);
    });
});
