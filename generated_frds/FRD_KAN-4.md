# Functional Requirements Document: Simple Pension Scheme Setup Platform

## 1. Purpose and Scope
This document defines the functional requirements for the Simple Pension Scheme Setup Platform (KAN-4). The scope includes digital onboarding, contribution management, investment tracking, benefit payments, and audit logging.

## 2. System Context
- **Responsibilities:** Digitizing pension administration, automating compliance, and facilitating banking integrations.
- **Exclusions:** Not specified in the source; confirm payroll inputs, contribution-cycle triggers, and fund-performance data requirements.
- **Actors:** Scheme Administrators, Employers/HR Managers, Scheme Members, Regulators/Auditors.
- **Trust Boundaries:** Security controls must meet local financial-authority privacy/security requirements; specific authentication, authorization, and encryption choices are TBD.

## 3. Use Case Index
- UC-1: Employer/Member Onboarding
- UC-2: Contribution Processing
- UC-3: Investment Management
- UC-4: Benefit Disbursement
- UC-5: Audit Logging

## 4. Detailed Use Cases

- **UC-1 (FR-1):** Employer/member submits onboarding information; validation rules and resulting status values are TBD.
- **UC-2 (FR-2):** Contributions are processed and direct debit is initiated through the banking integration; input format, trigger, and failure handling are TBD.
- **UC-3 (FR-3):** Member reviews investment allocation and may request a fund switch; valuation source and switch rules are TBD.
- **UC-4 (FR-4):** The system calculates benefit payments and supports disbursement; eligibility rules and execution details are TBD.
- **UC-5 (FR-5):** The system records transaction audit events for regulatory review; event fields and retention are TBD.

## 5. Data Dictionary
- **Employer/Member Profile:** (Proposed) ID, Name, KYC Status, Contact Info.
- **Contribution Record:** (Proposed) Amount, Date, Status, Source Account.
- **Investment Allocation:** (Proposed) Fund ID, Percentage, Current Value.
- **Audit Log:** (Proposed) Timestamp, Actor, Action, Transaction ID.

## 6. Interfaces

- **Banking integration:** Required for contribution direct debit. Protocol, direction, payload, failure handling, and status/reconciliation behavior are TBD.
- **Benefit disbursement interface:** TBD; no external interface is confirmed by the source.

## 7. Constraints & NFRs
- **Security:** Compliance with local financial authority privacy regulations.
- **Availability/Performance:** TBD.

## 8. Traceability Matrix

| FR ID | Story ID | Module |
|---|---|---|
| FR-1 | US-FR-1 | MOD-ONBOARDING |
| FR-2 | US-FR-2 | MOD-CONTRIBUTIONS |
| FR-3 | US-FR-3 | MOD-INVESTMENTS |
| FR-4 | US-FR-4 | MOD-BENEFITS |
| FR-5 | US-FR-5 | MOD-COMPLIANCE |

## 9. Assumptions & Open Questions
- **Assumption:** Banking APIs support direct debit.
- **Open Question:** What is the specific latency requirement for transaction processing?
