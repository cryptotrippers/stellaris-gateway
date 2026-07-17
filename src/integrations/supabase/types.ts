export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      assets: {
        Row: {
          audit_report_url: string | null
          category: string
          created_at: string
          data_source: string
          description: string | null
          funding_status: string
          id: string
          issuer: string
          location: string | null
          maturity_months: number | null
          min_deposit_lovelace: number
          name: string
          oracle_feed_id: string | null
          raised_lovelace: number
          target_lovelace: number
          updated_at: string
        }
        Insert: {
          audit_report_url?: string | null
          category: string
          created_at?: string
          data_source?: string
          description?: string | null
          funding_status?: string
          id: string
          issuer: string
          location?: string | null
          maturity_months?: number | null
          min_deposit_lovelace?: number
          name: string
          oracle_feed_id?: string | null
          raised_lovelace?: number
          target_lovelace?: number
          updated_at?: string
        }
        Update: {
          audit_report_url?: string | null
          category?: string
          created_at?: string
          data_source?: string
          description?: string | null
          funding_status?: string
          id?: string
          issuer?: string
          location?: string | null
          maturity_months?: number | null
          min_deposit_lovelace?: number
          name?: string
          oracle_feed_id?: string | null
          raised_lovelace?: number
          target_lovelace?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assets_oracle_feed_fk"
            columns: ["oracle_feed_id"]
            isOneToOne: false
            referencedRelation: "oracle_feeds"
            referencedColumns: ["id"]
          },
        ]
      }
      contract_audits: {
        Row: {
          audited_at: string
          auditor: string
          blueprint_hash: string | null
          commit_hash: string
          contract_name: string
          created_at: string
          id: string
          network: string
          report_url: string
          updated_at: string
        }
        Insert: {
          audited_at: string
          auditor: string
          blueprint_hash?: string | null
          commit_hash: string
          contract_name: string
          created_at?: string
          id?: string
          network?: string
          report_url: string
          updated_at?: string
        }
        Update: {
          audited_at?: string
          auditor?: string
          blueprint_hash?: string | null
          commit_hash?: string
          contract_name?: string
          created_at?: string
          id?: string
          network?: string
          report_url?: string
          updated_at?: string
        }
        Relationships: []
      }
      governance_proposals: {
        Row: {
          created_at: string
          ends_at: string | null
          id: string
          sip_number: string
          status: Database["public"]["Enums"]["proposal_status"]
          title: string
          updated_at: string
          votes_for_pct: number
        }
        Insert: {
          created_at?: string
          ends_at?: string | null
          id?: string
          sip_number: string
          status?: Database["public"]["Enums"]["proposal_status"]
          title: string
          updated_at?: string
          votes_for_pct?: number
        }
        Update: {
          created_at?: string
          ends_at?: string | null
          id?: string
          sip_number?: string
          status?: Database["public"]["Enums"]["proposal_status"]
          title?: string
          updated_at?: string
          votes_for_pct?: number
        }
        Relationships: []
      }
      kyc_attestations: {
        Row: {
          attestation_type: string
          created_at: string
          expires_at: string | null
          id: string
          proof_cid: string
          subject_stake_address: string | null
          user_id: string
          verified_at: string
          verifier: string
        }
        Insert: {
          attestation_type: string
          created_at?: string
          expires_at?: string | null
          id?: string
          proof_cid: string
          subject_stake_address?: string | null
          user_id: string
          verified_at?: string
          verifier: string
        }
        Update: {
          attestation_type?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          proof_cid?: string
          subject_stake_address?: string | null
          user_id?: string
          verified_at?: string
          verifier?: string
        }
        Relationships: []
      }
      oracle_feeds: {
        Row: {
          created_at: string
          feed_address: string
          id: string
          last_observed_at: string | null
          last_price: number | null
          last_tx_hash: string | null
          network: string
          pair: string
          provider: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          feed_address: string
          id?: string
          last_observed_at?: string | null
          last_price?: number | null
          last_tx_hash?: string | null
          network?: string
          pair: string
          provider: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          feed_address?: string
          id?: string
          last_observed_at?: string | null
          last_price?: number | null
          last_tx_hash?: string | null
          network?: string
          pair?: string
          provider?: string
          updated_at?: string
        }
        Relationships: []
      }
      security_audit_log: {
        Row: {
          action: string
          created_at: string
          detail: Json | null
          id: string
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          detail?: Json | null
          id?: string
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          detail?: Json | null
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      security_sessions: {
        Row: {
          browser: string | null
          created_at: string
          device: string | null
          id: string
          last_seen: string
          location: string | null
          revoked: boolean
          user_id: string
        }
        Insert: {
          browser?: string | null
          created_at?: string
          device?: string | null
          id?: string
          last_seen?: string
          location?: string | null
          revoked?: boolean
          user_id: string
        }
        Update: {
          browser?: string | null
          created_at?: string
          device?: string | null
          id?: string
          last_seen?: string
          location?: string | null
          revoked?: boolean
          user_id?: string
        }
        Relationships: []
      }
      transactions: {
        Row: {
          amount_ada: number
          block_height: number | null
          created_at: string
          id: string
          tx_hash: string
          type: Database["public"]["Enums"]["transaction_type"]
          user_id: string
          vault_id: string
        }
        Insert: {
          amount_ada: number
          block_height?: number | null
          created_at?: string
          id?: string
          tx_hash: string
          type: Database["public"]["Enums"]["transaction_type"]
          user_id: string
          vault_id: string
        }
        Update: {
          amount_ada?: number
          block_height?: number | null
          created_at?: string
          id?: string
          tx_hash?: string
          type?: Database["public"]["Enums"]["transaction_type"]
          user_id?: string
          vault_id?: string
        }
        Relationships: []
      }
      treasury_config: {
        Row: {
          active_since_slot: number | null
          buyback_pct_bps: number
          created_at: string
          id: number
          network: string
          treasury_address: string | null
          updated_at: string
        }
        Insert: {
          active_since_slot?: number | null
          buyback_pct_bps?: number
          created_at?: string
          id?: number
          network?: string
          treasury_address?: string | null
          updated_at?: string
        }
        Update: {
          active_since_slot?: number | null
          buyback_pct_bps?: number
          created_at?: string
          id?: number
          network?: string
          treasury_address?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      treasury_events: {
        Row: {
          amount_lovelace: number
          block_time: string
          created_at: string
          event_type: string
          id: string
          network: string
          slot: number
          tx_hash: string
        }
        Insert: {
          amount_lovelace: number
          block_time: string
          created_at?: string
          event_type: string
          id?: string
          network?: string
          slot: number
          tx_hash: string
        }
        Update: {
          amount_lovelace?: number
          block_time?: string
          created_at?: string
          event_type?: string
          id?: string
          network?: string
          slot?: number
          tx_hash?: string
        }
        Relationships: []
      }
      user_profiles: {
        Row: {
          created_at: string
          id: string
          kyc_status: Database["public"]["Enums"]["kyc_status"]
          updated_at: string
          user_id: string
          wallet_address: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          kyc_status?: Database["public"]["Enums"]["kyc_status"]
          updated_at?: string
          user_id: string
          wallet_address?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          kyc_status?: Database["public"]["Enums"]["kyc_status"]
          updated_at?: string
          user_id?: string
          wallet_address?: string | null
        }
        Relationships: []
      }
      user_security_settings: {
        Row: {
          created_at: string
          hardware_wallet: boolean
          id: string
          mfa: boolean
          timelock_24h: boolean
          updated_at: string
          user_id: string
          withdrawal_whitelist: boolean
        }
        Insert: {
          created_at?: string
          hardware_wallet?: boolean
          id?: string
          mfa?: boolean
          timelock_24h?: boolean
          updated_at?: string
          user_id: string
          withdrawal_whitelist?: boolean
        }
        Update: {
          created_at?: string
          hardware_wallet?: boolean
          id?: string
          mfa?: boolean
          timelock_24h?: boolean
          updated_at?: string
          user_id?: string
          withdrawal_whitelist?: boolean
        }
        Relationships: []
      }
      vault_positions: {
        Row: {
          amount_ada: number
          id: string
          opened_at: string
          tx_hash: string
          user_id: string
          vault_id: string
        }
        Insert: {
          amount_ada: number
          id?: string
          opened_at?: string
          tx_hash: string
          user_id: string
          vault_id: string
        }
        Update: {
          amount_ada?: number
          id?: string
          opened_at?: string
          tx_hash?: string
          user_id?: string
          vault_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      kyc_status: "unverified" | "pending" | "verified" | "rejected"
      proposal_status: "draft" | "active" | "passed" | "rejected" | "executed"
      transaction_type: "deposit" | "withdraw" | "yield"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      kyc_status: ["unverified", "pending", "verified", "rejected"],
      proposal_status: ["draft", "active", "passed", "rejected", "executed"],
      transaction_type: ["deposit", "withdraw", "yield"],
    },
  },
} as const
