# System Architecture Document: Simple Pension Scheme Setup Platform

## 1. Executive Summary

The platform supports digital onboarding, contribution management, investment tracking, benefit payments, and audit logging. Confirmed constraint: comply with local financial-authority privacy and security regulations.

## 2. Architecture Pattern & Topology

**Proposed Pattern:** Modular Monolith.

A single deployable system with explicit module boundaries is a candidate approach. Confirm deployment, transaction, and scaling needs before approval.

## 3. Component Catalog & Service Boundaries

- **MOD-ONBOARDING:** Manages digital employer and member onboarding.
- **MOD-CONTRIBUTIONS:** Manages contribution processing and required direct-debit integration.
- **MOD-INVESTMENTS:** Supports investment allocation tracking and fund switching.
- **MOD-BENEFITS:** Calculates benefit payments; disbursement execution details are TBD.
- **MOD-COMPLIANCE:** Maintains audit logs for regulatory review.

## 4. Integration & Communication Contracts

- Banking integration is required for direct debit. Protocol, direction details, authentication, retries, and reconciliation behavior are TBD.
- Internal module communication remains within the proposed modular boundary; no separate event platform is assumed.

## 5. Data Architecture Strategy

- Target database engine and storage technology are TBD. The ERD models only source-backed managed entities.
- Audit retention and immutability requirements need confirmation against applicable regulations.

## 6. Security, Authentication & Trust Boundaries

- Confirmed constraint: comply with local financial-authority privacy and security regulations.
- Authentication, authorization, encryption, key management, and trust-boundary controls are TBD.

## 7. Scalability, Resilience & Non-Functional Architecture

- Availability, performance, throughput, resilience mechanisms, and recovery targets are TBD; no numeric service level is established by the source.

## 8. Deployment Architecture

- Hosting, runtime, containerization, orchestration, CI/CD, and observability choices are TBD.

## 9. Traceability Matrix

| Component ID | Module ID | Source FR IDs | User Story IDs |
|---|---|---|---|
| COMP-ONBOARDING-1 | MOD-ONBOARDING | FR-1 | US-FR-1 |
| COMP-CONTRIBUTIONS-2 | MOD-CONTRIBUTIONS | FR-2 | US-FR-2 |
| COMP-INVESTMENTS-3 | MOD-INVESTMENTS | FR-3 | US-FR-3 |
| COMP-BENEFITS-4 | MOD-BENEFITS | FR-4 | US-FR-4 |
| COMP-COMPLIANCE-5 | MOD-COMPLIANCE | FR-5 | US-FR-5 |

## 10. ADRs & Technical Assumptions

- ADR-001: A modular monolith is proposed for an initial clear module boundary; revisit if confirmed scaling or deployment needs require another pattern.
- Technology decisions, including the database engine, remain TBD.
