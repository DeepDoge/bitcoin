import { css, mixin } from "~/frontend/utils/dom/css.ts";

export const GlobalStyle = css`
	:root {
		--base: #0b0b0d;
		--pop: #f2f2f5;

		--accent-base: hsl(33, 83%, 50%);
		--accent-pop: hsl(36, 46%, 98%);

		--positive-base: hsl(150, 55%, 48%);
		--positive-pop: hsl(150, 55%, 10%);

		--mute-min: 35%;
		--mute-max: 88%;

		--radius-min: 0.35em;
		--radius-max: 0.75em;

		--surface: color-mix(in srgb, transparent, #d2d2ff 5%);
	}

	:root {
		color-scheme: dark;
		font-family: monospace;
		line-height: 1.4;
		font-size: 1rem;
		accent-color: var(--accent-base);

		-webkit-font-smoothing: antialiased;
		-moz-osx-font-smoothing: grayscale;
	}

	*,
	*::before,
	*::after {
		box-sizing: border-box;
	}

	* {
		margin: 0;
	}

	html {
		container-type: inline-size;
		scrollbar-gutter: stable;
	}

	body {
		background-color: var(--base);
		color: var(--pop);
	}

	a {
		font-weight: bolder;
		text-decoration: none;
		&:hover {
			text-decoration: underline;
		}
	}

	ol,
	ul {
		list-style: none;
		padding: 0;
	}

	h1,
	h2,
	h3,
	h4,
	h6,
	h6 {
		font: inherit;
	}

	hr {
		opacity: .2;
		border: none;
		block-size: 1px;
		background-image: currentcolor;
	}

	meter {
		/* strip native rendering so the pseudo-elements below take over */
		appearance: none;
		display: block grid;
		inline-size: 100%;
		block-size: 1em;
		border: none;
		border-radius: var(--radius-min);
		overflow: clip;
		background-image: none;
		background-color: var(--surface);

		--base: color-mix(in srgb, currentcolor, transparent 50%);
	}

	meter::-webkit-meter-inner-element {
		appearance: none;
		all: unset;
		display: block grid;
		position: relative;
	}

	meter::-webkit-meter-bar {
		border: none;
		block-size: 100%;
		background-image: none;
	}

	meter::-webkit-meter-optimum-value {
		background-image: none;
		background-color: var(--base);
		border-inline-end: solid 2px currentcolor;
	}
	meter::-webkit-meter-suboptimum-value {
		background-image: none;
		background-color: var(--base);
	}
	meter::-webkit-meter-even-less-good-value {
		background-image: none;
		background-color: var(--base);
	}

	meter::-moz-meter-bar {
		background-image: none;
		background-color: var(--base);
	}
`;

export const WideLetterSpacingMixin = mixin`
	letter-spacing: 0.14em;
`;

export const TextTrimMixin = mixin`
	text-box: trim-both cap alphabetic;
`;
