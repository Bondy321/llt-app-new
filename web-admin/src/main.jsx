import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './index.css';

// Custom theme for Loch Lomond Travel
const theme = createTheme({
  primaryColor: 'brand',
  colors: {
    brand: [
      '#e5f4ff',
      '#cde4ff',
      '#9bc6fb',
      '#64a6f6',
      '#388bf2',
      '#1a7af0',
      '#007DC3', // Primary brand color
      '#0066a8',
      '#005a8f',
      '#004d7a'
    ],
    accent: [
      '#fff4e6',
      '#ffe8cc',
      '#ffd099',
      '#ffb866',
      '#ff9f33',
      '#ff8800',
      '#E67E22', // Accent orange
      '#cc6600',
      '#b35500',
      '#994400'
    ]
  },
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  headings: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  defaultRadius: 'md',
  components: {
    Button: {
      defaultProps: {
        radius: 'md',
      },
    },
    Card: {
      defaultProps: {
        radius: 'md',
        shadow: 'sm',
      },
    },
    TextInput: {
      defaultProps: {
        radius: 'md',
      },
    },
    PasswordInput: {
      defaultProps: {
        radius: 'md',
      },
    },
    Select: {
      defaultProps: {
        radius: 'md',
      },
    },
    Textarea: {
      defaultProps: {
        radius: 'md',
      },
    },
  },
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <Notifications position="top-right" zIndex={1000} />
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </MantineProvider>
  </StrictMode>
);
