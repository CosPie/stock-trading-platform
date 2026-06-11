module.exports = {
  content: ["./frontend/**/*.{html,js,svelte}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Noto Sans SC",
          "PingFang SC",
          "Microsoft YaHei",
          "sans-serif",
        ],
      },
    },
  },
  daisyui: {
    themes: [
      {
        trading: {
          primary: "#1f766d",
          secondary: "#3f5f8f",
          accent: "#b7791f",
          neutral: "#253332",
          "base-100": "#f7faf7",
          "base-200": "#edf3ef",
          "base-300": "#dde7e2",
          "base-content": "#172221",
          info: "#2d6cdf",
          success: "#21845b",
          warning: "#bd7b11",
          error: "#b84b3e",
        },
      },
    ],
  },
  plugins: [require("daisyui")],
};
