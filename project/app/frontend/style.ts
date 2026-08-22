import { css } from "~/frontend/utils/dom/css.ts";

export const GlobalStyle = css`
	:root {
		--base: #0b0b0d;
		--pop: #f2f2f5;

		--accent-base: hsl(33, 83%, 50%);
		--accent-pop: hsl(36, 46%, 98%);

		--mute-min: 35%;
		--mute-max: 88%;

		--radius-min: 0.35em;
		--radius-max: 0.75em;

		--surface: color-mix(in srgb, transparent, #d2d2ff 4%);
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
`;
